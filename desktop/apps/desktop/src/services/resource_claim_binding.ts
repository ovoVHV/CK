import { analyzeHardwareResources } from './hardware_resource_graph';
import type { ResourceClaim } from './hardware_resource_graph';
import { validateResourceClaims, validateResourceGraph } from './resource_contract';
import type { ResourceOperand } from './resource_contract';
import { isConvertedField, staticInputValue } from './blockly_compat_analysis';

export interface ResourceBlock {
  id: string; type: string;
  getFieldValue(name: string): unknown;
  getInputTargetBlock(name: string): ResourceBlock | null;
}
export interface ResourceCatalogEntry {
  type: string; library_id?: string; metadata_source?: string;
  fields?: { name: string }[]; inputs?: { name: string }[];
  hardware?: { claims?: unknown };
}
function literal(source: ResourceOperand, block: ResourceBlock): string | number | boolean | undefined {
  let value: unknown;
  if (source.kind === 'fixed') value = source.value;
  else if (source.kind === 'field' && !isConvertedField(block, source.name!)) value = block.getFieldValue(source.name!);
  else {
    const input = block.getInputTargetBlock(source.name!);
    value = staticInputValue(input);
  }
  if (source.valueType === 'integer') {
    if (typeof value === 'string' && /^(?:-?\d+|0x[\da-f]+)$/i.test(value)) value = Number(value);
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
  }
  if (source.valueType === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) ? value : undefined;
}
/** Shared built-in/third-party boundary: no board IDs, FQBNs, names or generator matching. */
export function analyzeDeclaredHardware(board: { resource_graph?: unknown }, catalog: ResourceCatalogEntry[], blocks: ResourceBlock[]) {
  if (blocks.length > 4096) throw new Error('resource.claim_limit');
  const gaps: { code: string; block?: string }[] = [];
  if (board.resource_graph === undefined) return { report: null, claims: [] as ResourceClaim[], gaps: [{ code: 'missing-board-resource-graph' }] };
  const graph = validateResourceGraph(board.resource_graph);
  const aliases = new Map(graph.resources.flatMap(r => [[r.id, r.id], ...(r.aliases ?? []).map(a => [a, r.id])]) as [string, string][]);
  const entries = new Map<string, ResourceCatalogEntry>();
  for (const entry of catalog) {
    if (entries.has(entry.type)) throw new Error('resource.ambiguous_block_type');
    entries.set(entry.type, entry);
  }
  const claims: ResourceClaim[] = [];
  for (const block of blocks) {
    const entry = entries.get(block.type);
    if (entry?.metadata_source !== 'v2' || entry.hardware?.claims === undefined) { gaps.push({ code: 'missing-claim-declaration', block: block.id }); continue; }
    const declaration = validateResourceClaims(entry.hardware.claims, (entry.fields ?? []).map(f => f.name), (entry.inputs ?? []).map(i => i.name));
    if (declaration.coverage !== 'full') gaps.push({ code: 'incomplete-claim-declaration', block: block.id });
    for (const template of declaration.templates) {
      let unresolved = false;
      const resolve = (s: ResourceOperand) => {
        const value = literal(s, block);
        if (value === undefined) unresolved = true;
        return value;
      };
      const resourceValue = resolve(template.resource);
      const resource = aliases.get(String(resourceValue));
      if (!resource) unresolved = true;
      const ownerValue = template.owner ? resolve(template.owner) : block.id;
      const discriminator = template.discriminator ? resolve(template.discriminator) : undefined;
      const configuration: Record<string, string | number | boolean> = {};
      for (const [key, source] of Object.entries(template.configuration ?? {})) { const v = resolve(source); if (v !== undefined) configuration[key] = v; }
      const signals: Record<string, string> = {};
      for (const [key, source] of Object.entries(template.signals ?? {})) {
        const v = aliases.get(String(resolve(source)));
        if (v === undefined) unresolved = true; else signals[key] = v;
      }
      if (unresolved) { gaps.push({ code: 'unresolved-claim', block: block.id }); continue; }
      const policy = graph.resources.find(r => r.id === resource)!.sharing;
      // Numeric addresses have exactly one representation across decimal/hex fields and inputs.
      // A textual address declaration must not evade collision checking through formatting.
      if (policy === 'address' && (typeof discriminator !== 'number' || !Number.isSafeInteger(discriminator) || discriminator < 0)) {
        gaps.push({ code: 'unresolved-address', block: block.id }); continue;
      }
      // v1 package binding supports a flat reachable bus only. Authors cannot invent isolated segments.
      const claim: ResourceClaim = { id: `claim:${claims.length}`, reference: block.id, owner: JSON.stringify([entry.library_id ?? entry.type, ownerValue]), resource: resource!, role: template.role, configuration, signals };
      if (template.exclusive !== undefined) claim.exclusive = template.exclusive;
      if (discriminator !== undefined) claim.discriminator = String(discriminator);
      if (policy === 'address') claim.segment = resource!;
      claims.push(claim);
      if (claims.length > 4096) throw new Error('resource.claim_limit');
    }
  }
  return { report: analyzeHardwareResources(graph, claims, gaps.length), claims, gaps };
}
