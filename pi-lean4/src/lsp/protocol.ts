/**
 * The slice of LSP, and of Lean's extensions to it, that pi-lean4 speaks.
 *
 * Lean's server is the source of truth for these shapes (Lean.Server.Protocol
 * in the toolchain's src/). test/lean/contract.test.ts pins the ones the design
 * leans on against the pinned toolchain, so a re-pin that changes one fails
 * there rather than as a mystery in a tool.
 */

import type { Position, Range } from "./positions.ts";

export type { Position, Range };

/** LSP DiagnosticSeverity → the names the tools use. */
export const SEVERITY_NAMES: Record<number, "error" | "warning" | "info" | "hint"> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
};

export interface Diagnostic {
	range: Range;
	/** Lean's own: the whole extent, where `range` may be just its first line. */
	fullRange?: Range;
	severity?: 1 | 2 | 3 | 4;
	code?: string | number;
	source?: string;
	message: string;
	/** 1 = unnecessary, 2 = deprecated, plus Lean's own tags (e.g. goals accomplished). */
	tags?: number[];
	leanTags?: number[];
	/** Lean marks some messages (e.g. `trace` output) silent; they still count. */
	isSilent?: boolean;
	relatedInformation?: unknown[];
	data?: unknown;
}

export interface PublishDiagnosticsParams {
	uri: string;
	version?: number;
	diagnostics: Diagnostic[];
}

/** `$/lean/fileProgress`: what is still being elaborated. kind 2 = fatal error. */
export interface FileProgressParams {
	textDocument: { uri: string; version?: number };
	processing: { range: Range; kind?: number }[];
}

/** `$/lean/staleDependency`: an imported module changed under an open file. */
export interface StaleDependencyParams {
	staleDependency: string;
}

/** `$/lean/plainGoal` → this, or null where there is no tactic state. */
export interface PlainGoal {
	rendered: string;
	goals: string[];
}

/** `$/lean/plainTermGoal` → this, or null. */
export interface PlainTermGoal {
	goal: string;
	range: Range;
}

export interface MarkupContent {
	kind: "markdown" | "plaintext";
	value: string;
}

export interface Hover {
	contents: MarkupContent | string | (string | { language: string; value: string })[];
	range?: Range;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	targetUri: string;
	targetRange: Range;
	targetSelectionRange: Range;
	originSelectionRange?: Range;
}

export interface CompletionItem {
	label: string;
	kind?: number;
	detail?: string;
	documentation?: string | MarkupContent;
	sortText?: string;
	data?: unknown;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

export interface CodeAction {
	title: string;
	kind?: string;
	isPreferred?: boolean;
	diagnostics?: Diagnostic[];
	edit?: {
		changes?: Record<string, TextEdit[]>;
		documentChanges?: { textDocument: { uri: string; version?: number | null }; edits: TextEdit[] }[];
	};
	data?: unknown;
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: number;
	location: Location;
	containerName?: string;
}

/** LSP SymbolKind names, for the outline. */
export const SYMBOL_KINDS: Record<number, string> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enumMember",
	23: "struct",
	24: "event",
	25: "operator",
	26: "typeParameter",
};

export const COMPLETION_KINDS: Record<number, string> = {
	1: "text",
	2: "method",
	3: "function",
	4: "constructor",
	5: "field",
	6: "variable",
	7: "class",
	8: "interface",
	9: "module",
	10: "property",
	11: "unit",
	12: "value",
	13: "enum",
	14: "keyword",
	15: "snippet",
	16: "color",
	17: "file",
	18: "reference",
	19: "folder",
	20: "enumMember",
	21: "constant",
	22: "struct",
	23: "event",
	24: "operator",
	25: "typeParameter",
};

/** `dependencyBuildMode` on Lean's didOpen: whether opening may run lake. */
export type DependencyBuildMode = "always" | "once" | "never";

export function buildInitializeParams(opts: { root: string; rootUri: string; name: string; version: string }): unknown {
	return {
		processId: process.pid,
		clientInfo: { name: opts.name, version: opts.version },
		rootUri: opts.rootUri,
		workspaceFolders: [{ uri: opts.rootUri, name: opts.root.split("/").pop() || opts.root }],
		// editDelay 0: we send whole versions and then wait on a barrier, so
		// there is no keystroke stream to debounce. No widgets: nothing renders them.
		initializationOptions: { editDelay: 0, hasWidgets: false },
		capabilities: {
			general: { positionEncodings: ["utf-16"] },
			textDocument: {
				synchronization: { didSave: true, dynamicRegistration: false },
				publishDiagnostics: { versionSupport: true, relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
				hover: { contentFormat: ["markdown", "plaintext"] },
				completion: {
					completionItem: { resolveSupport: { properties: ["detail", "documentation"] } },
				},
				definition: { linkSupport: true },
				declaration: { linkSupport: true },
				references: {},
				documentSymbol: { hierarchicalDocumentSymbolSupport: true },
				codeAction: {
					codeActionLiteralSupport: {
						codeActionKind: { valueSet: ["", "quickfix", "refactor", "source"] },
					},
					resolveSupport: { properties: ["edit"] },
					dataSupport: true,
					isPreferredSupport: true,
				},
			},
			workspace: { workspaceEdit: { documentChanges: true }, symbol: {}, didChangeWatchedFiles: { dynamicRegistration: false } },
			window: { workDoneProgress: false },
		},
	};
}
