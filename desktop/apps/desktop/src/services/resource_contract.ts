import Ajv2020 from 'ajv/dist/2020';
import graphSchema from '../../../../docs/schemas/ck-resource-graph.schema.json';
import claimsSchema from '../../../../docs/schemas/ck-resource-claims.schema.json';
import limits from '../../../../docs/schemas/ck-resource-boundary.json';
import type { BoardResourceGraph, ResourceCoverage } from './hardware_resource_graph';

export interface ResourceOperand { kind: 'fixed' | 'field' | 'input'; valueType: 'id' | 'integer' | 'boolean'; name?: string; value?: string | number | boolean }
export interface ResourceClaimTemplate {
  id: string; resource: ResourceOperand; owner?: ResourceOperand; role: string;
  exclusive?: boolean; discriminator?: ResourceOperand;
  configuration?: Record<string, ResourceOperand>; signals?: Record<string, ResourceOperand>;
}
export interface ResourceClaimDeclaration { version: 1; coverage: ResourceCoverage; templates: ResourceClaimTemplate[] }
const ajv = new Ajv2020({ strict: false, allErrors: false, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const graphValidator = ajv.compile<BoardResourceGraph>(graphSchema);
const claimsValidator = ajv.compile<ResourceClaimDeclaration>(claimsSchema);
const utf8 = new TextEncoder();
/** Identical JSON limits to Rust. JS additionally rejects getters/custom prototypes before access. */
export function assertResourceJson(value: unknown): void {
  let nodes = 0, bytes = 0;
  const walk = (v: unknown, depth: number) => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw new Error('resource.limit');
    if (typeof v === 'string') {
      if (Array.from(v).length > limits.maxStringLength) throw new Error('resource.string_limit');
      bytes += utf8.encode(v).length;
    } else if (v !== null && typeof v === 'object') {
      const array = Array.isArray(v);
      if (array && Object.getPrototypeOf(v) !== Array.prototype) throw new Error('resource.prototype');
      if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new Error('resource.prototype');
      if (Object.getOwnPropertySymbols(v).length) throw new Error('resource.symbol');
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (array && Object.keys(descriptors).length !== (v as unknown[]).length + 1) throw new Error('resource.sparse_array');
      for (const [key, d] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (v as unknown[]).length)) throw new Error('resource.array_property');
        if (limits.forbiddenKeys.includes(key) || d.get || d.set || !d.enumerable) throw new Error('resource.unsafe_key');
        if (!array) bytes += utf8.encode(key).length;
        walk(d.value, depth + 1);
      }
    } else if (v !== null && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) throw new Error('resource.json_only');
    if (bytes > limits.maxTextBytes) throw new Error('resource.byte_limit');
  };
  walk(value, 0);
}
export function validateResourceGraph(value: unknown): BoardResourceGraph {
  assertResourceJson(value);
  if (!graphValidator(value)) throw new Error(`resource.schema:${graphValidator.errors?.[0]?.instancePath}`);
  const g = value as BoardResourceGraph;
  const resources = new Map(g.resources.map(r => [r.id, r]));
  const evidence = new Set(g.evidence.map(e => e.id));
  if (resources.size !== g.resources.length || evidence.size !== g.evidence.length) throw new Error('resource.duplicate_id');
  const aliases = new Set(resources.keys());
  for (const r of g.resources) {
    for (const alias of r.aliases ?? []) {
      if (aliases.has(alias)) throw new Error('resource.ambiguous_alias');
      aliases.add(alias);
    }
    if (r.evidence.some(e => !evidence.has(e))) throw new Error('resource.evidence_reference');
    const seen = new Set([r.id]);
    let parent = r.parent;
    while (parent) {
      if (!resources.has(parent) || seen.has(parent)) throw new Error('resource.parent');
      seen.add(parent); parent = resources.get(parent)!.parent;
    }
  }
  const routes = new Set<string>(), signals = new Set<string>();
  for (const r of g.routes) {
    const signal = JSON.stringify([r.resource, r.signal]);
    if (routes.has(r.id) || signals.has(signal) || !resources.has(r.resource) || r.pins.some(p => !resources.has(p))) throw new Error('resource.route');
    routes.add(r.id); signals.add(signal);
  }
  return JSON.parse(JSON.stringify(g));
}
export function claimOperands(template: ResourceClaimTemplate): ResourceOperand[] {
  return [template.resource, template.owner, template.discriminator, ...Object.values(template.configuration ?? {}), ...Object.values(template.signals ?? {})].filter((x): x is ResourceOperand => !!x);
}
export function validateResourceClaims(value: unknown, fields: readonly string[], inputs: readonly string[]): ResourceClaimDeclaration {
  assertResourceJson(value);
  if (!claimsValidator(value)) throw new Error(`resource.claim_schema:${claimsValidator.errors?.[0]?.instancePath}`);
  const declaration = value as ResourceClaimDeclaration;
  const ids = new Set<string>();
  for (const t of declaration.templates) {
    if (ids.has(t.id)) throw new Error('resource.duplicate_claim');
    ids.add(t.id);
    for (const source of claimOperands(t)) {
      if ((source.kind === 'field' && !fields.includes(source.name!)) || (source.kind === 'input' && !inputs.includes(source.name!))) throw new Error('resource.undeclared_source');
    }
  }
  return JSON.parse(JSON.stringify(declaration));
}
