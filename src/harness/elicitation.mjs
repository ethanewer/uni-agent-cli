// Pure validation and normalization for ACP form elicitation. The TUI lives in
// pi-harness.mjs; keeping the schema boundary here makes it independently
// testable and prevents backend-provided JSON Schema from reaching rendering or
// regular-expression APIs unchecked.

export const ELICITATION_LIMITS = Object.freeze({
	schemaBytes: 128 * 1024,
	fields: 32,
	totalOptions: 512,
	optionsPerField: 100,
	propertyNameCharacters: 128,
	titleCharacters: 256,
	descriptionCharacters: 2_048,
	optionCharacters: 512,
	inputCharacters: 4_096,
	patternCharacters: 256,
});

const STRING_FORMATS = new Set(["email", "uri", "date", "date-time"]);
const DANGEROUS_PROPERTY_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_HINT = /(?:password|passwd|passphrase|secret|credential|authorization|cookie|private[\s_-]*key|api[\s_-]*(?:key|token)|bearer[\s_-]*token|oauth[\s_-]*token|(?:^|[\s_-])token(?:$|[\s_-])|access[\s_-]*token|auth(?:entication|orization)?[\s_-]*token)/iu;

function isPlainObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function characterLength(value) {
	return Array.from(value).length;
}

function boundedString(value, name, limit, options = {}) {
	if (value === undefined && options.optional) return undefined;
	if (typeof value !== "string") throw new Error(`${name} must be text`);
	if (characterLength(value) > limit) throw new Error(`${name} is too long`);
	if (value.includes("\0")) throw new Error(`${name} contains invalid control characters`);
	return value;
}

// Backend copy is untrusted terminal content. Strip common ANSI/OSC sequences,
// then every remaining C0/C1 control, before it is ever handed to a component.
export function safeElicitationDisplayText(value, limit = ELICITATION_LIMITS.descriptionCharacters) {
	const source = typeof value === "string" ? value : "";
	const plain = source
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/gu, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
		.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
	return Array.from(plain).slice(0, limit).join("");
}

function optionalDisplayString(value, name, limit) {
	if (value === undefined || value === null) return undefined;
	boundedString(value, name, limit);
	return safeElicitationDisplayText(value, limit);
}

function boundedNonnegativeInteger(value, name, maximum) {
	if (value === undefined || value === null) return undefined;
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new Error(`${name} must be a bounded non-negative integer`);
	}
	return value;
}

function boundedFiniteNumber(value, name, integer = false) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
		throw new Error(`${name} must be a finite${integer ? " safe integer" : " number"}`);
	}
	return value;
}

function optionList(values, name, titled = false) {
	if (!Array.isArray(values) || values.length === 0 || values.length > ELICITATION_LIMITS.optionsPerField) {
		throw new Error(`${name} must contain 1-${ELICITATION_LIMITS.optionsPerField} options`);
	}
	const seen = new Set();
	return values.map((entry, index) => {
		let value;
		let title;
		let description;
		if (titled) {
			if (!isPlainObject(entry)) throw new Error(`${name}[${index}] must be an object`);
			value = boundedString(entry.const, `${name}[${index}].const`, ELICITATION_LIMITS.optionCharacters);
			title = boundedString(entry.title, `${name}[${index}].title`, ELICITATION_LIMITS.optionCharacters);
			description = optionalDisplayString(
				entry.description,
				`${name}[${index}].description`,
				ELICITATION_LIMITS.descriptionCharacters,
			);
		} else {
			value = boundedString(entry, `${name}[${index}]`, ELICITATION_LIMITS.optionCharacters);
			title = value;
		}
		if (seen.has(value)) throw new Error(`${name} contains duplicate values`);
		seen.add(value);
		return {
			value,
			label: safeElicitationDisplayText(title, ELICITATION_LIMITS.optionCharacters) || `Option ${index + 1}`,
			...(description ? { description } : {}),
		};
	});
}

// JavaScript regular expressions can otherwise turn an untrusted schema into a
// main-thread denial of service. Accept only a conservative subset: groups may
// not be repeated and a pattern may contain at most one unbounded or wide-range
// quantifier. This excludes ambiguous adjacent repetitions such as a+a+$ without
// trying to prove an arbitrary ECMAScript expression safe.
function compileBoundedPattern(pattern, name) {
	boundedString(pattern, name, ELICITATION_LIMITS.patternCharacters);
	if (/\\[1-9]/u.test(pattern) || /\(\?/u.test(pattern)) {
		throw new Error(`${name} uses unsupported backtracking constructs`);
	}
	// A repeated group is where nested/ambiguous quantifiers most commonly become
	// exponential. Conservatively reject every repeated group rather than trying
	// to prove an arbitrary ECMAScript expression safe.
	if (/\)(?:[*+]|\{\d+(?:,\d*)?\})/u.test(pattern)) {
		throw new Error(`${name} uses an unsafe repeated group`);
	}
	let inClass = false;
	let unboundedQuantifiers = 0;
	let optionalQuantifiers = 0;
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "\\") {
			// Skip the escaped atom. Unicode property escapes include a brace payload;
			// they are safe atoms, not repetition quantifiers.
			if ((pattern[index + 1] === "p" || pattern[index + 1] === "P") && pattern[index + 2] === "{") {
				const end = pattern.indexOf("}", index + 3);
				if (end < 0) break;
				index = end;
			} else {
				index += 1;
			}
			continue;
		}
		if (character === "[") {
			inClass = true;
			continue;
		}
		if (character === "]" && inClass) {
			inClass = false;
			continue;
		}
		if (inClass) continue;
		if (character === "*" || character === "+") {
			unboundedQuantifiers += 1;
			continue;
		}
		if (character === "?") {
			optionalQuantifiers += 1;
			continue;
		}
		if (character !== "{") continue;
		const quantifier = /^(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(index + 1));
		if (!quantifier) continue;
		const minimum = Number(quantifier[1]);
		const hasComma = quantifier[2] !== undefined;
		const maximum = hasComma && quantifier[2] !== "" ? Number(quantifier[2]) : undefined;
		if (minimum > ELICITATION_LIMITS.inputCharacters || (maximum !== undefined && maximum > ELICITATION_LIMITS.inputCharacters)) {
			throw new Error(`${name} uses an excessive repetition bound`);
		}
		if (hasComma && maximum === undefined) unboundedQuantifiers += 1;
		else if (hasComma && maximum !== minimum) {
			if (maximum - minimum <= 1) optionalQuantifiers += 1;
			else unboundedQuantifiers += 1;
		}
		index += quantifier[0].length;
	}
	if (unboundedQuantifiers > 1 || optionalQuantifiers > 16) {
		throw new Error(`${name} is too complex to evaluate safely`);
	}
	try {
		return new RegExp(pattern, "u");
	} catch {
		throw new Error(`${name} is not a valid regular expression`);
	}
}

function metaSuggestsSecret(meta) {
	if (!isPlainObject(meta)) return false;
	let visited = 0;
	const visit = (value, depth) => {
		if (visited++ > 64 || depth > 3) return false;
		if (typeof value === "string") return SECRET_HINT.test(value) || /^(?:password|secret|sensitive|masked)$/iu.test(value);
		if (value === true) return false;
		if (Array.isArray(value)) return value.slice(0, 16).some((entry) => visit(entry, depth + 1));
		if (!isPlainObject(value)) return false;
		return Object.entries(value).slice(0, 32).some(([key, entry]) => {
			if (/(?:secret|sensitive|password|masked)/iu.test(key) && entry === true) return true;
			return SECRET_HINT.test(key) || visit(entry, depth + 1);
		});
	};
	return visit(meta, 0);
}

function commonField(propertyName, schema, required) {
	const title = optionalDisplayString(schema.title, `${propertyName}.title`, ELICITATION_LIMITS.titleCharacters)
		|| safeElicitationDisplayText(propertyName, ELICITATION_LIMITS.titleCharacters);
	const description = optionalDisplayString(
		schema.description,
		`${propertyName}.description`,
		ELICITATION_LIMITS.descriptionCharacters,
	);
	return {
		key: propertyName,
		title,
		...(description ? { description } : {}),
		required,
		secret: SECRET_HINT.test(propertyName)
			|| SECRET_HINT.test(schema.title ?? "")
			|| SECRET_HINT.test(description ?? "")
			|| metaSuggestsSecret(schema._meta),
	};
}

function normalizeStringField(propertyName, schema, required) {
	const field = { ...commonField(propertyName, schema, required), type: "string" };
	const minLength = boundedNonnegativeInteger(schema.minLength, `${propertyName}.minLength`, ELICITATION_LIMITS.inputCharacters);
	const maxLength = boundedNonnegativeInteger(schema.maxLength, `${propertyName}.maxLength`, ELICITATION_LIMITS.inputCharacters);
	if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
		throw new Error(`${propertyName}.minLength exceeds maxLength`);
	}
	if (minLength !== undefined) field.minLength = minLength;
	if (maxLength !== undefined) field.maxLength = maxLength;
	if (schema.pattern !== undefined && schema.pattern !== null) {
		field.pattern = boundedString(schema.pattern, `${propertyName}.pattern`, ELICITATION_LIMITS.patternCharacters);
		field.patternRegex = compileBoundedPattern(field.pattern, `${propertyName}.pattern`);
	}
	if (schema.format !== undefined && schema.format !== null) {
		if (typeof schema.format !== "string" || !STRING_FORMATS.has(schema.format)) {
			throw new Error(`${propertyName}.format is unsupported`);
		}
		field.format = schema.format;
	}
	if (schema.enum != null && schema.oneOf != null) {
		throw new Error(`${propertyName} cannot define both enum and oneOf`);
	}
	if (schema.enum != null) field.options = optionList(schema.enum, `${propertyName}.enum`);
	if (schema.oneOf != null) field.options = optionList(schema.oneOf, `${propertyName}.oneOf`, true);
	if (schema.default !== undefined && schema.default !== null) {
		field.default = boundedString(schema.default, `${propertyName}.default`, ELICITATION_LIMITS.inputCharacters);
		const checked = validateElicitationFieldValue(field, field.default);
		if (!checked.ok) throw new Error(`${propertyName}.default ${checked.error}`);
	}
	return field;
}

function normalizeNumericField(propertyName, schema, required, integer) {
	const type = integer ? "integer" : "number";
	const field = { ...commonField(propertyName, schema, required), type };
	// JSON Schema permits fractional bounds for integer instances. Keep the
	// bounds finite, but apply the safe-integer restriction only to defaults and
	// submitted values.
	const minimum = boundedFiniteNumber(schema.minimum, `${propertyName}.minimum`);
	const maximum = boundedFiniteNumber(schema.maximum, `${propertyName}.maximum`);
	if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
		throw new Error(`${propertyName}.minimum exceeds maximum`);
	}
	if (minimum !== undefined) field.minimum = minimum;
	if (maximum !== undefined) field.maximum = maximum;
	if (schema.default !== undefined && schema.default !== null) {
		field.default = boundedFiniteNumber(schema.default, `${propertyName}.default`, integer);
		const checked = validateElicitationFieldValue(field, String(field.default));
		if (!checked.ok) throw new Error(`${propertyName}.default ${checked.error}`);
	}
	return field;
}

function normalizeBooleanField(propertyName, schema, required) {
	const field = { ...commonField(propertyName, schema, required), type: "boolean" };
	if (schema.default !== undefined && schema.default !== null) {
		if (typeof schema.default !== "boolean") throw new Error(`${propertyName}.default must be boolean`);
		field.default = schema.default;
	}
	return field;
}

function normalizeArrayField(propertyName, schema, required) {
	if (!isPlainObject(schema.items)) throw new Error(`${propertyName}.items must be an object`);
	let options;
	if (schema.items.type === "string" && schema.items.enum != null) {
		options = optionList(schema.items.enum, `${propertyName}.items.enum`);
	} else if (schema.items.anyOf != null && (schema.items.type == null || schema.items.type === "string")) {
		options = optionList(schema.items.anyOf, `${propertyName}.items.anyOf`, true);
	} else {
		throw new Error(`${propertyName}.items must define a string enum or anyOf`);
	}
	const field = { ...commonField(propertyName, schema, required), type: "array", options };
	const minItems = boundedNonnegativeInteger(schema.minItems, `${propertyName}.minItems`, options.length);
	const maxItems = boundedNonnegativeInteger(schema.maxItems, `${propertyName}.maxItems`, options.length);
	if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
		throw new Error(`${propertyName}.minItems exceeds maxItems`);
	}
	if (minItems !== undefined) field.minItems = minItems;
	if (maxItems !== undefined) field.maxItems = maxItems;
	if (schema.default !== undefined && schema.default !== null) {
		if (!Array.isArray(schema.default)) throw new Error(`${propertyName}.default must be an array`);
		field.default = schema.default.map((entry, index) =>
			boundedString(entry, `${propertyName}.default[${index}]`, ELICITATION_LIMITS.optionCharacters));
		const checked = validateElicitationFieldValue(field, field.default);
		if (!checked.ok) throw new Error(`${propertyName}.default ${checked.error}`);
	}
	return field;
}

function normalizeProperty(propertyName, schema, required) {
	if (!isPlainObject(schema) || typeof schema.type !== "string") throw new Error(`${propertyName} has an invalid schema`);
	switch (schema.type) {
		case "string": return normalizeStringField(propertyName, schema, required);
		case "number": return normalizeNumericField(propertyName, schema, required, false);
		case "integer": return normalizeNumericField(propertyName, schema, required, true);
		case "boolean": return normalizeBooleanField(propertyName, schema, required);
		case "array": return normalizeArrayField(propertyName, schema, required);
		default: throw new Error(`${propertyName} uses unsupported type ${safeElicitationDisplayText(schema.type, 32) || "unknown"}`);
	}
}

export function normalizeElicitationFormRequest(params) {
	if (!isPlainObject(params) || params.mode !== "form") throw new Error("form elicitation request is invalid");
	let encoded;
	let schema;
	try {
		encoded = JSON.stringify(params.requestedSchema);
	} catch {
		throw new Error("form elicitation schema is not serializable");
	}
	if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > ELICITATION_LIMITS.schemaBytes) {
		throw new Error("form elicitation schema exceeds the safety limit");
	}
	try {
		schema = JSON.parse(encoded);
	} catch {
		throw new Error("form elicitation schema is not serializable");
	}
	const propertySchemas = isPlainObject(schema) && schema.properties === undefined ? {} : schema?.properties;
	if (!isPlainObject(schema) || (schema.type != null && schema.type !== "object") || !isPlainObject(propertySchemas)) {
		throw new Error("form elicitation schema must be a flat object with properties");
	}
	const properties = Object.entries(propertySchemas);
	if (properties.length > ELICITATION_LIMITS.fields) {
		throw new Error(`form elicitation cannot contain more than ${ELICITATION_LIMITS.fields} fields`);
	}
	const propertyNames = new Set(properties.map(([name]) => name));
	for (const propertyName of propertyNames) {
		boundedString(propertyName, "property name", ELICITATION_LIMITS.propertyNameCharacters);
		if (
			!propertyName ||
			/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(propertyName) ||
			DANGEROUS_PROPERTY_NAMES.has(propertyName)
		) {
			throw new Error("form elicitation contains an unsafe property name");
		}
	}
	const requiredValues = schema.required == null ? [] : schema.required;
	if (!Array.isArray(requiredValues) || requiredValues.length > properties.length) {
		throw new Error("form elicitation required list is invalid");
	}
	const required = new Set();
	for (const name of requiredValues) {
		if (typeof name !== "string" || !propertyNames.has(name) || required.has(name)) {
			throw new Error("form elicitation required list is invalid");
		}
		required.add(name);
	}
	const fields = properties.map(([propertyName, propertySchema]) =>
		normalizeProperty(propertyName, propertySchema, required.has(propertyName)));
	const totalOptions = fields.reduce((total, field) => total + (field.options?.length ?? 0), 0);
	if (totalOptions > ELICITATION_LIMITS.totalOptions) throw new Error("form elicitation contains too many options");
	const message = boundedString(params.message ?? "Input requested", "elicitation message", ELICITATION_LIMITS.descriptionCharacters);
	const schemaTitle = optionalDisplayString(schema.title, "schema title", ELICITATION_LIMITS.titleCharacters);
	const schemaDescription = optionalDisplayString(schema.description, "schema description", ELICITATION_LIMITS.descriptionCharacters);
	return {
		title: schemaTitle || safeElicitationDisplayText(message, ELICITATION_LIMITS.titleCharacters) || "Input requested",
		message: safeElicitationDisplayText(message, ELICITATION_LIMITS.descriptionCharacters),
		...(schemaDescription ? { description: schemaDescription } : {}),
		fields,
	};
}

function validDate(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validFormat(value, format) {
	if (!format) return true;
	if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
	if (format === "uri") {
		try {
			const url = new URL(value);
			return Boolean(url.protocol);
		} catch {
			return false;
		}
	}
	if (format === "date") return validDate(value);
	if (format === "date-time") {
		const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
		if (!match || !validDate(match[1])) return false;
		const hour = Number(match[2]);
		const minute = Number(match[3]);
		const second = Number(match[4]);
		if (hour > 23 || minute > 59 || second > 59) return false;
		if (match[5] !== "Z" && (Number(match[6]) > 23 || Number(match[7]) > 59)) return false;
		return !Number.isNaN(Date.parse(value));
	}
	return false;
}

export function validateElicitationFieldValue(field, rawValue) {
	const label = field?.title || "Field";
	if (rawValue === undefined) {
		return field?.required
			? { ok: false, error: `${label} is required` }
			: { ok: true, omit: true };
	}
	if (field.type === "string") {
		if (typeof rawValue !== "string") return { ok: false, error: `${label} must be text` };
		if (characterLength(rawValue) > ELICITATION_LIMITS.inputCharacters || rawValue.includes("\0")) {
			return { ok: false, error: `${label} exceeds the input safety limit` };
		}
		if (!field.required && rawValue === "" && !field.options) return { ok: true, omit: true };
		const length = characterLength(rawValue);
		if (field.minLength !== undefined && length < field.minLength) return { ok: false, error: `${label} is too short` };
		if (field.maxLength !== undefined && length > field.maxLength) return { ok: false, error: `${label} is too long` };
		if (field.options && !field.options.some((option) => option.value === rawValue)) return { ok: false, error: `${label} is not an allowed option` };
		if (field.patternRegex && !field.patternRegex.test(rawValue)) return { ok: false, error: `${label} does not match the required pattern` };
		if (!validFormat(rawValue, field.format)) return { ok: false, error: `${label} is not a valid ${field.format}` };
		return { ok: true, value: rawValue };
	}
	if (field.type === "number" || field.type === "integer") {
		if (rawValue === "" && !field.required) return { ok: true, omit: true };
		if (typeof rawValue !== "number" && typeof rawValue !== "string") {
			return { ok: false, error: `${label} must be ${field.type === "integer" ? "a safe integer" : "a number"}` };
		}
		if (typeof rawValue === "string") {
			const syntax = field.type === "integer"
				? /^-?(?:0|[1-9]\d*)$/u
				: /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
			if (!syntax.test(rawValue)) return { ok: false, error: `${label} must be ${field.type === "integer" ? "a safe integer" : "a number"}` };
		}
		const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
		if (!Number.isFinite(value) || (field.type === "integer" && !Number.isSafeInteger(value))) {
			return { ok: false, error: `${label} must be ${field.type === "integer" ? "a safe integer" : "a number"}` };
		}
		if (field.minimum !== undefined && value < field.minimum) return { ok: false, error: `${label} is below the minimum` };
		if (field.maximum !== undefined && value > field.maximum) return { ok: false, error: `${label} is above the maximum` };
		return { ok: true, value };
	}
	if (field.type === "boolean") {
		if (typeof rawValue !== "boolean") return { ok: false, error: `${label} must be true or false` };
		return { ok: true, value: rawValue };
	}
	if (field.type === "array") {
		if (!Array.isArray(rawValue)) return { ok: false, error: `${label} must be a selection` };
		const allowed = new Set(field.options.map((option) => option.value));
		const unique = new Set();
		for (const value of rawValue) {
			if (typeof value !== "string" || !allowed.has(value) || unique.has(value)) {
				return { ok: false, error: `${label} contains an invalid selection` };
			}
			unique.add(value);
		}
		if (field.minItems !== undefined && rawValue.length < field.minItems) return { ok: false, error: `${label} needs more selections` };
		if (field.maxItems !== undefined && rawValue.length > field.maxItems) return { ok: false, error: `${label} has too many selections` };
		return { ok: true, value: [...rawValue] };
	}
	return { ok: false, error: `${label} has an unsupported type` };
}

export function normalizeElicitationResponse(params, candidate) {
	if (!isPlainObject(candidate) || !["accept", "decline", "cancel"].includes(candidate.action)) return { action: "cancel" };
	if (candidate.action !== "accept") return { action: candidate.action };
	if (params?.mode === "url") return { action: "accept" };
	if (params?.mode !== "form") return { action: "cancel" };
	let form;
	try {
		form = normalizeElicitationFormRequest(params);
	} catch {
		return { action: "cancel" };
	}
	if (!isPlainObject(candidate.content)) return { action: "cancel" };
	const known = new Set(form.fields.map((field) => field.key));
	if (Object.keys(candidate.content).some((key) => !known.has(key))) return { action: "cancel" };
	const content = Object.create(null);
	for (const field of form.fields) {
		const rawValue = Object.prototype.hasOwnProperty.call(candidate.content, field.key)
			? candidate.content[field.key]
			: undefined;
		const checked = validateElicitationFieldValue(field, rawValue);
		if (!checked.ok) return { action: "cancel" };
		if (!checked.omit) content[field.key] = checked.value;
	}
	return { action: "accept", content };
}
