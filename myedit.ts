import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

const EDIT_FAIL_REASON = {
	missingFile: "missing-file",
	notFound: "not-found",
	ambiguous: "ambiguous",
} as const;

/** Cap on lines a single replacement may span — surgical changes only. */
const MAX_EDIT_LINES = 200;

// ── Types ────────────────────────────────────────────────────────────────────

interface IReplacement {
	oldString: string;
	newString: string;
}

interface EditOk { ok: true; file: string; count?: number }
interface EditFail { ok: false; file: string; index?: number; reason: string; matches?: number }
type EditsResult = EditOk | EditFail;

// ── Core edit algorithm (1:1 from tsforge) ───────────────────────────────────

/**
 * Apply a SEQUENCE of str_replace edits to one file, ATOMICALLY: each match must
 * be exact and unique in the content as it stands after the prior replacements;
 * if any one fails, NOTHING is written and the failing replacement's index +
 * reason is returned. This lets the model fix the same issue at several spread-
 * out sites in a single turn (each piece still surgical) instead of a whole-file
 * rewrite — while the all-or-nothing write keeps a half-applied batch off disk.
 */
function applyEdits(path: string, edits: readonly IReplacement[]): EditsResult {
	if (!existsSync(path)) {
		return { ok: false, file: path, index: 0, reason: EDIT_FAIL_REASON.missingFile };
	}

	if (edits.length === 0) {
		return { ok: false, file: path, index: 0, reason: EDIT_FAIL_REASON.notFound };
	}

	let content = readFileSync(path, "utf-8");

	for (let i = 0; i < edits.length; i += 1) {
		const replacement = edits[i];

		if (replacement === undefined || replacement.oldString === "") {
			return { ok: false, file: path, index: i, reason: EDIT_FAIL_REASON.notFound };
		}

		const matches = content.split(replacement.oldString).length - 1;

		if (matches === 0) {
			// Exact match failed — try an indentation-tolerant LINE match (the common
			// LLM miss: right code, slightly-off leading whitespace). Applies ONLY on a
			// unique window; never guesses. The gate re-validates as a backstop.
			const fuzzy = fuzzyLineReplace(
				content,
				replacement.oldString,
				replacement.newString
			);

			if (fuzzy.matches === 1) {
				content = fuzzy.text;
				continue;
			}

			if (fuzzy.matches > 1) {
				return {
					ok: false,
					file: path,
					index: i,
					reason: EDIT_FAIL_REASON.ambiguous,
					matches: fuzzy.matches,
				};
			}

			return { ok: false, file: path, index: i, reason: EDIT_FAIL_REASON.notFound };
		}

		if (matches > 1) {
			return {
				ok: false,
				file: path,
				index: i,
				reason: EDIT_FAIL_REASON.ambiguous,
				matches,
			};
		}

		content = content.split(replacement.oldString).join(replacement.newString);
	}

	writeFileSync(path, content, "utf-8");
	return { ok: true, file: path, count: edits.length };
}

/**
 * Indentation-tolerant line match: compare `oldString` to `content` line-by-line
 * ignoring each line's leading/trailing whitespace. Returns the new content with
 * the matched window replaced by `newString` — but ONLY when exactly one window
 * matches (`matches === 1`); 0 or >1 leaves content untouched so the caller can
 * report not-found/ambiguous rather than guess. Line-granular (not char-offset),
 * which keeps it simple and safe.
 */
function fuzzyLineReplace(
	content: string,
	oldString: string,
	newString: string
): { text: string; matches: number } {
	const norm = (s: string): string => s.trim();
	const crlfCount = (content.match(/\r\n/g) || []).length;
	const lfTotal = (content.match(/\n/g) || []).length;
	const lineEnding = crlfCount > (lfTotal - crlfCount) ? "\r\n" : "\n";
	const contentLines = content.split(lineEnding);
	const oldLines = oldString.split("\n");

	// Drop blank leading/trailing lines (the model often adds a stray newline).
	while (oldLines.length > 0 && norm(oldLines[0] ?? "") === "") {
		oldLines.shift();
	}

	while (
		oldLines.length > 0 &&
		norm(oldLines[oldLines.length - 1] ?? "") === ""
	) {
		oldLines.pop();
	}

	if (oldLines.length === 0) {
		return { text: content, matches: 0 };
	}

	const needle = oldLines.map(norm);
	const starts: number[] = [];

	for (let i = 0; i + needle.length <= contentLines.length; i += 1) {
		let hit = true;

		for (let j = 0; j < needle.length; j += 1) {
			if (norm(contentLines[i + j] ?? "") !== needle[j]) {
				hit = false;
				break;
			}
		}

		if (hit) {
			starts.push(i);
		}
	}

	if (starts.length !== 1) {
		return { text: content, matches: starts.length };
	}

	const start = starts[0] ?? 0;
	const rebuilt = [
		...contentLines.slice(0, start),
		...newString.split("\n"),
		...contentLines.slice(start + needle.length),
	];

	return { text: rebuilt.join(lineEnding), matches: 1 };
}

// ── Actionable feedback for LLM (1:1 from tsforge file-ops) ──────────────────

/**
 * Turn an edit-failure reason into ACTIONABLE feedback. The bare reason strings
 * ("not-found", "missing-file") were fatally ambiguous: a slow local model read
 * an edit's "not-found" (= the oldString wasn't in the file) as "the FILE wasn't
 * found", switched to `write`, hit "already exists", and thrashed edit↔write to
 * the turn cap. Each message now says exactly what failed AND what to do next —
 * crucially, whether the file exists (don't `write`) or not (do `write`).
 */
function editFailHelp(file: string, result: { reason: string; matches?: number }): string {
	if (result.reason === EDIT_FAIL_REASON.ambiguous) {
		return `oldString matched ${result.matches ?? 0} places — include more surrounding lines to make it unique`;
	}

	if (result.reason === EDIT_FAIL_REASON.missingFile) {
		return `the file ${file} does not exist yet — use \`write\` to make it (NOT edit)`;
	}

	if (result.reason === EDIT_FAIL_REASON.notFound) {
		return `the file ${file} EXISTS, but your oldString text was not found in it. Do NOT use \`write\` (it already exists). \`read\` the file to see its exact current contents, then edit with text copied verbatim from it.`;
	}

	return result.reason;
}

// ── Tool definition ──────────────────────────────────────────────────────────

const editTool = defineTool({
	name: "myedit",
	label: "myedit",
	description: `Apply str_replace edits to a file. Each edit specifies an \`oldString\` (exact text to find) and a \`newString\` (replacement). The match must be exact and unique — 0 matches is not-found, >1 is ambiguous.

Pass multiple replacements in the \`edits\` array to fix several spread-out sites in one turn. All replacements are applied atomically: if any one fails, nothing is written.`,
	parameters: Type.Object({
		file: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(
			Type.Object({
				oldString: Type.String({ description: "Exact text to find (must be unique in the file)" }),
				newString: Type.String({ description: "Replacement text" }),
			}),
		),
	}),
	async execute(_id, { file: filePath, edits }, _signal, _onUpdate, _ctx) {
		let resolvedFile = filePath;
		const home = homedir();
		if (resolvedFile === "~") {
			resolvedFile = home;
		} else if (resolvedFile.startsWith("~/") || (process.platform === "win32" && resolvedFile.startsWith("~\\"))) {
			resolvedFile = join(home, resolvedFile.slice(2));
		}
		const absPath = resolve(resolvedFile);

		// Soft warning for oversized replacements — don't block, just inform.
		const warnings: string[] = [];
		for (let i = 0; i < edits.length; i += 1) {
			const span = (edits[i]?.oldString ?? "").split("\n").length;
			if (span > MAX_EDIT_LINES) {
				warnings.push(`replacement #${i + 1} spans ${span} lines (>${MAX_EDIT_LINES}). Prefer small, targeted changes — split into separate edits if possible.`);
			}
		}

		const result = applyEdits(absPath, edits);

		if (result.ok) {
			let text = `edited ${absPath} (${result.count} change${result.count === 1 ? "" : "s"})`;
			if (warnings.length > 0) {
				text += `\n\nWarnings:\n${warnings.map(w => `- ⚠ ${w}`).join("\n")}`;
			}
			return { content: [{ type: "text", text }] };
		}

		const where = result.index !== undefined && edits.length > 1
			? ` (replacement #${result.index + 1})`
			: "";

		let text = `edit ${absPath} REJECTED${where}: ${editFailHelp(absPath, result)}`;
		if (warnings.length > 0) {
			text += `\n\nWarnings:\n${warnings.map(w => `- ⚠ ${w}`).join("\n")}`;
		}

		return { content: [{ type: "text", text }] };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(editTool);
}
