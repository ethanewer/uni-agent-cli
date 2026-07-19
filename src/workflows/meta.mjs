// Metadata validation and source wrapping are adapted from the MIT-licensed
// open-dynamic-workflows grammar, with Acorn providing a non-executing parser.
import { parse } from "acorn";
import { WORKFLOW_LIMITS } from "./types.mjs";

export function assertDeterministicWorkflowSource(source) {
	if (typeof source !== "string") throw new Error("workflow source must be a string");
	// Node's UTF-8 encoder replaces lone UTF-16 surrogates with U+FFFD. Reject
	// ill-formed strings so the bytes hashed for approval cannot collide with a
	// different source that JSON transports verbatim.
	if (typeof source.isWellFormed === "function" ? !source.isWellFormed() : /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(source)) {
		throw new Error("workflow source must be well-formed Unicode");
	}
	if (Buffer.byteLength(source, "utf8") > WORKFLOW_LIMITS.maxSourceBytes) throw new Error("workflow source is too large");
	if (source.startsWith("#!")) throw new Error("Workflow source cannot use a hashbang");
}

function assertDeterministicAst(node) {
	const forbidden = new Map([
		["Date", "Date"], ["crypto", "crypto randomness"], ["performance", "ambient clocks"],
		["setTimeout", "timers"], ["setInterval", "timers"], ["setImmediate", "timers"], ["queueMicrotask", "timers"],
	]);
	const visit = (value, parentKey = "") => {
		if (!value || typeof value !== "object") return;
		if (value.type === "Identifier" && forbidden.has(value.name) && parentKey !== "key") {
			throw new Error(`Workflow source cannot use ${forbidden.get(value.name)}`);
		}
		if (value.type === "MemberExpression" && value.object?.type === "Identifier" && value.object.name === "Math") {
			const property = value.computed ? value.property?.value : value.property?.name;
			if (property === "random") throw new Error("Workflow source cannot use randomness");
		}
		if (value.type === "ImportExpression") throw new Error("Workflow dynamic imports are unavailable");
		for (const [key, child] of Object.entries(value)) {
			if (["start", "end", "loc"].includes(key)) continue;
			if (Array.isArray(child)) child.forEach((entry) => visit(entry, key));
			else visit(child, key);
		}
	};
	visit(node);
}

function parseWorkflow(source) {
	assertDeterministicWorkflowSource(source);
	try {
		const ast = parse(source, {
			ecmaVersion: "latest",
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
		});
		assertDeterministicAst(ast);
		return ast;
	} catch (error) {
		throw new Error(`Invalid workflow JavaScript: ${error.message ?? error}`);
	}
}

function pureLiteral(node) {
	if (!node) throw new Error("workflow meta contains an empty value");
	if (node.type === "Literal" && ["string", "number", "boolean"].includes(typeof node.value) || node.type === "Literal" && node.value === null) return node.value;
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
	if (node.type === "UnaryExpression" && ["+", "-"].includes(node.operator) && node.argument.type === "Literal" && typeof node.argument.value === "number") {
		return node.operator === "-" ? -node.argument.value : node.argument.value;
	}
	if (node.type === "ArrayExpression") return node.elements.map(pureLiteral);
	if (node.type === "ObjectExpression") {
		const result = Object.create(null);
		for (const property of node.properties) {
			if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed) throw new Error("workflow meta must contain only plain literal properties");
			const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
			if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error("workflow meta contains an unsafe property");
			result[key] = pureLiteral(property.value);
		}
		return result;
	}
	throw new Error("workflow meta must be a pure object literal");
}

function metadataDeclaration(source) {
	const ast = parseWorkflow(source);
	let found;
	for (const node of ast.body) {
		if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportDefaultDeclaration") {
			throw new Error("workflow imports and exports other than `export const meta` are unavailable");
		}
		if (node.type !== "ExportNamedDeclaration") continue;
		const declaration = node.declaration;
		const valid = declaration?.type === "VariableDeclaration" && declaration.kind === "const" && declaration.declarations.length === 1 &&
			declaration.declarations[0].id?.type === "Identifier" && declaration.declarations[0].id.name === "meta";
		if (!valid || found) throw new Error("workflow supports exactly one `export const meta` declaration and no other exports");
		found = { exportNode: node, declaration, initializer: declaration.declarations[0].init };
	}
	if (!found) throw new Error("workflow must declare `export const meta = { ... }`");
	return found;
}

export function extractWorkflowMeta(source) {
	const { initializer } = metadataDeclaration(source);
	const value = pureLiteral(initializer);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workflow meta must be an object literal");
	if (typeof value.name !== "string" || !value.name.trim()) throw new Error("workflow meta.name is required");
	if (typeof value.description !== "string" || !value.description.trim()) throw new Error("workflow meta.description is required");
	const phases = value.phases === undefined ? [] : value.phases;
	if (!Array.isArray(phases) || phases.some((phase) => typeof phase !== "string" || !phase.trim())) throw new Error("workflow meta.phases must be an array of strings");
	return Object.freeze({
		name: [...value.name.trim()].slice(0, 128).join(""),
		description: [...value.description.trim()].slice(0, 2000).join(""),
		...(typeof value.whenToUse === "string" ? { whenToUse: value.whenToUse.slice(0, 2000) } : {}),
		phases: phases.slice(0, 64).map((phase) => [...phase.trim()].slice(0, 128).join("")),
	});
}

export function transformWorkflowSource(source) {
	const { exportNode, declaration } = metadataDeclaration(source);
	const transformed = `${source.slice(0, exportNode.start)}${source.slice(declaration.start)}`;
	return `"use strict";\n(async function __ccWorkflowMain(){\n${transformed}\n})()`;
}
