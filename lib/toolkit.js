// Tool-definition helpers.
//
// A DSH tool definition needs `parameters` as real JSON Schema and an `output`
// descriptor; upstream's `defineTool` also compiles the ergonomic author
// vocabulary and validates arguments before the body runs. This module prefers
// the shipped implementation and falls back to a local one that understands the
// same vocabulary, so the plugin still loads if the shipped resolver is
// unavailable.
const [toolsModule, schemaModule] = await Promise.all([
  import('@deepseek-ai/dsh-tools').catch(() => null),
  import('@deepseek-ai/schemastery').catch(() => null),
]);

export const usingShippedToolkit = typeof toolsModule?.defineTool === 'function';
export const z = schemaModule?.default ?? null;

/** Author node keys that pass straight through to JSON Schema. */
function copyThrough(spec, out) {
  for (const key of ['type', 'enum', 'const', 'description', 'title', 'default', 'examples']) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }
}

/** Compile one author node (object / array / scalar) into JSON Schema. */
export function compileNode(spec) {
  if (spec === undefined || spec === null) return {};
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(`schema node must be an object, received ${JSON.stringify(spec)}`);
  }
  const out = {};
  copyThrough(spec, out);
  if (Array.isArray(spec.oneOf)) out.oneOf = spec.oneOf.map((member) => compileNode(member));
  if (spec.items !== undefined) out.items = compileNode(spec.items);
  if (spec.properties !== undefined) {
    const compiled = compilePropertyMap(spec.properties);
    out.properties = compiled.properties;
    if (compiled.required.length > 0) out.required = compiled.required;
    if (spec.additionalProperties !== undefined) out.additionalProperties = spec.additionalProperties === true;
  } else if (spec.additionalProperties !== undefined) {
    out.additionalProperties = spec.additionalProperties === true;
  }
  return out;
}

/** Compile a property map, hoisting each member's `required: true` flag. */
export function compilePropertyMap(spec) {
  if (spec === undefined || spec === null) return { properties: {}, required: [] };
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    properties[key] = compileNode(value);
    if (value && value.required === true) required.push(key);
  }
  return { properties, required };
}

/** Compile the implicit root parameter object. */
export function compileParameters(spec) {
  const { properties, required } = compilePropertyMap(spec);
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties };
}

function checkType(node, value) {
  if (node.type === undefined) return true;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  for (const t of types) {
    if (t === 'null' && value === null) return true;
    if (t === 'array' && Array.isArray(value)) return true;
    if (t === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) return true;
    if (t === 'integer' && Number.isInteger(value)) return true;
    if (t === 'number' && typeof value === 'number' && Number.isFinite(value)) return true;
    if (t === 'string' && typeof value === 'string') return true;
    if (t === 'boolean' && typeof value === 'boolean') return true;
  }
  return false;
}

/** Minimal structural validation matching the shipped validator's contract. */
export function validateJsonSchemaValue(schema, value, path) {
  const violations = [];
  const walk = (node, current, where) => {
    if (!node || typeof node !== 'object') return;
    if (node.oneOf) {
      const ok = node.oneOf.some((member) => validateJsonSchemaValue(member, current, where).length === 0);
      if (!ok) violations.push(`${where} does not match any allowed shape`);
      return;
    }
    if (!checkType(node, current)) {
      violations.push(`${where} must be ${node.type}`);
      return;
    }
    if (node.enum && !node.enum.includes(current)) violations.push(`${where} must be one of ${JSON.stringify(node.enum)}`);
    if (node.const !== undefined && current !== node.const) violations.push(`${where} must be ${JSON.stringify(node.const)}`);
    if (Array.isArray(current) && node.items) current.forEach((item, i) => walk(node.items, item, `${where}[${i}]`));
    if (current !== null && typeof current === 'object' && !Array.isArray(current) && node.properties) {
      for (const name of node.required ?? []) {
        if (current[name] === undefined) violations.push(`${where}.${name} is required`);
      }
      for (const [name, member] of Object.entries(node.properties)) {
        if (current[name] !== undefined) walk(member, current[name], `${where}.${name}`);
      }
      if (node.additionalProperties === false) {
        for (const name of Object.keys(current)) {
          if (!Object.hasOwn(node.properties, name)) violations.push(`${where}.${name} is not an allowed property`);
        }
      }
    }
  };
  walk(schema, value, path);
  return violations;
}

class LocalToolArgsError extends Error {
  constructor(violations) {
    super(`invalid tool arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgsError';
    this.violations = violations;
  }
}

/**
 * Reject a value the real registry would refuse. The shipped registry snapshots
 * every tool result as lossless JSON and validates it against the output schema,
 * so this local stand-in has to do the same: otherwise a whole class of defect
 * (an `undefined` property, a NaN, a class instance) only surfaces after the
 * plugin is installed and a real model calls the tool.
 */
export function assertLosslessJson(toolName, value, path = 'value') {
  const seen = new Set();
  const walk = (current, where) => {
    if (current === undefined) throw new Error(`tool "${toolName}" returned undefined at ${where}`);
    if (current === null) return;
    const kind = typeof current;
    if (kind === 'number') {
      if (!Number.isFinite(current)) throw new Error(`tool "${toolName}" returned a non-finite number at ${where}`);
      return;
    }
    if (kind === 'string' || kind === 'boolean') return;
    if (kind === 'function' || kind === 'symbol' || kind === 'bigint') {
      throw new Error(`tool "${toolName}" returned a ${kind} at ${where}, which is not JSON`);
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${where}[${index}]`));
      return;
    }
    if (kind === 'object') {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`tool "${toolName}" returned a non-plain object at ${where}`);
      }
      if (seen.has(current)) throw new Error(`tool "${toolName}" returned a cyclic value at ${where}`);
      seen.add(current);
      for (const [key, item] of Object.entries(current)) walk(item, `${where}.${key}`);
      seen.delete(current);
      return;
    }
    throw new Error(`tool "${toolName}" returned an unsupported value at ${where}`);
  };
  walk(value, path);
  return value;
}

/** Local stand-in for the shipped `defineTool`, with the same author vocabulary. */
function localDefineTool(options) {
  const parameters = compileParameters(options.parameters);
  const outputSchema = options.output?.schema === undefined ? { type: 'object' } : compileNode(options.output.schema);
  const render = options.output?.render ?? (() => []);
  const validate = (candidate) => validateJsonSchemaValue(parameters, candidate, 'arguments');
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: outputSchema, render },
    async execute(candidate, exec) {
      const violations = validate(candidate);
      if (violations.length > 0) throw new LocalToolArgsError(violations);
      const value = await options.execute(candidate, exec);
      assertLosslessJson(options.name, value);
      const outputViolations = validateJsonSchemaValue(outputSchema, value, 'value');
      if (outputViolations.length > 0) {
        throw new Error(`tool "${options.name}" returned a value its output schema rejects: ${outputViolations.join('; ')}`);
      }
      return value;
    },
  };
  if (options.presentCall) tool.presentCall = (candidate) => (validate(candidate).length > 0 ? undefined : options.presentCall(candidate));
  if (options.presentResult) tool.presentResult = (candidate, result) => (validate(candidate).length > 0 ? undefined : options.presentResult(candidate, result));
  if (options.isConcurrencySafe) tool.isConcurrencySafe = (candidate) => (validate(candidate).length > 0 ? false : options.isConcurrencySafe(candidate));
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;
  if (options.projectContent) tool.projectContent = options.projectContent;
  if (options.finalizeContent) tool.finalizeContent = options.finalizeContent;
  return tool;
}

export const defineTool = usingShippedToolkit ? toolsModule.defineTool : localDefineTool;

/** One model-facing text block. */
export function text(value) {
  return [{ type: 'text', text: String(value) }];
}

/** A text block followed by the image it describes, when one was attached. */
export function textAndImage(value, attachment) {
  const blocks = text(value);
  if (attachment) blocks.push({ type: 'image', attachment });
  return blocks;
}

/** Format a JSON value as an indented, size-bounded text block. */
export function json(value, indent = 2) {
  return text(JSON.stringify(value, null, indent));
}

/** Refuse a value the caller must supply. */
export function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

/** Clamp an integer argument into range, rejecting non-numbers outright. */
export function intOr(value, fallback, { min = -1e9, max = 1e9, name = 'value' } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number, got ${JSON.stringify(value)}`);
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) throw new Error(`${name} must be between ${min} and ${max}, got ${rounded}`);
  return rounded;
}

/** An integer argument that the caller must supply. */
export function mustInt(value, name, opts = {}) {
  if (value === undefined || value === null) throw new Error(`${name} is required`);
  return intOr(value, undefined, { name, ...opts });
}
