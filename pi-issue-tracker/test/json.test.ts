import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractJsonArray, extractJsonObject, parseJsonObject } from "../src/json.ts";

/**
 * Getting JSON back out of model prose.
 *
 * Untested until it moved out of `extensions/index.ts`, which cannot be imported
 * without a pi runtime — so the parsing that decides whether a whole plan or a
 * whole review survives was previously only exercised by a live model.
 */

describe("extractJsonArray", () => {
	it("passes a bare array through", () => {
		assert.equal(extractJsonArray('[{"a":1}]'), '[{"a":1}]');
	});

	it("unwraps a ```json fence", () => {
		assert.equal(extractJsonArray('```json\n[{"a":1}]\n```'), '[{"a":1}]');
	});

	it("unwraps an unlabelled fence", () => {
		assert.equal(extractJsonArray('```\n[1,2]\n```'), "[1,2]");
	});

	it("strips prose on both sides", () => {
		assert.equal(extractJsonArray('Here you go:\n[1,2]\nHope that helps!'), "[1,2]");
	});

	it("takes the outermost brackets, so nested arrays survive", () => {
		assert.equal(extractJsonArray("[[1],[2]]"), "[[1],[2]]");
	});

	it("returns the body unchanged when there is no array to find", () => {
		assert.equal(extractJsonArray("no json here"), "no json here");
	});
});

describe("extractJsonObject", () => {
	it("unwraps a fenced object", () => {
		assert.equal(extractJsonObject('```json\n{"verdict":"approved"}\n```'), '{"verdict":"approved"}');
	});

	it("strips prose on both sides", () => {
		assert.equal(extractJsonObject('My review:\n{"verdict":"approved"}\nLet me know.'), '{"verdict":"approved"}');
	});

	it("takes the outermost braces, so nested objects survive", () => {
		assert.equal(extractJsonObject('{"a":{"b":1}}'), '{"a":{"b":1}}');
	});
});

describe("parseJsonObject", () => {
	it("parses an object", () => {
		assert.deepEqual(parseJsonObject('{"verdict":"approved"}'), { verdict: "approved" });
	});

	it("parses through a fence and surrounding prose", () => {
		assert.deepEqual(parseJsonObject('Sure:\n```json\n{"n":1}\n```'), { n: 1 });
	});

	// Every caller treats "the model produced something unusable" as an outcome
	// to report, not an exception to unwind a tool call with.
	it("returns null on malformed JSON rather than throwing", () => {
		assert.equal(parseJsonObject('{"verdict": approved}'), null);
	});

	it("returns null on prose with no JSON at all", () => {
		assert.equal(parseJsonObject("I think it looks great!"), null);
	});

	it("returns null for an array, which is not an object", () => {
		assert.equal(parseJsonObject("[1,2]"), null);
	});

	it("returns null for a bare null", () => {
		assert.equal(parseJsonObject("null"), null);
	});
});
