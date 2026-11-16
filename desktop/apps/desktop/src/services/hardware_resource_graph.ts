/** Presentation-only hardware analysis. Never serialize this report into build identity. */
import { validateResourceGraph as validateBoardResourceGraph } from './resource_contract';
export type ResourceCoverage = 'full' | 'partial' | 'unknown';
export type SharingPolicy = 'shared' | 'exclusive' | 'configuration' | 'address' | 'selector' | 'unknown';
export interface ResourceEvidence {
  id: string;
  source: string;
  locator?: string;
  confidence: 'verified' | 'declared' | 'unknown';
}
export interface HardwareResource {
  id: string;
  type: string;
  parent?: string;
  aliases?: string[];
  capabilities?: string[];
  sharing: SharingPolicy;
  configurationKeys?: string[];
  reserved?: boolean;
  evidence: string[];
}
export interface ResourceRoute {
  id: string;
  resource: string;
  signal: string;
  mode: 'fixed' | 'selectable';
  pins: string[];
}
export interface BoardResourceGraph {
  version: 1;
  resources: HardwareResource[];
  routes: ResourceRoute[];
  evidence: ResourceEvidence[];
  coverage: ResourceCoverage;
}
export interface ResourceClaim {
  id: string;
  owner: string;
  reference: string;
  resource: string;
  role: string;
  exclusive?: boolean;
  configuration?: Record<string, string | number | boolean>;
  /** Already normalized machine address / chip-select identity; not a display label. */
  discriminator?: string;
  /** Reachable segment identity, resolved by topology binding, never a display label. */
  segment?: string;
  /** Selected pins keyed by route signal; required for selectable routes. */
  signals?: Record<string, string>;
}
export interface ResourceBinding {
  claim: ResourceClaim;
  resource: HardwareResource;
  ancestors: string[];
}
export interface ResourceAnalysis {
  coverage: ResourceCoverage;
  bindings: ResourceBinding[];
  conflicts: { code: string; resource: string; claims: string[] }[];
  gaps: { code: string; claim?: string; resource?: string }[];
  usages: { resource: string; roles: string[]; owners: string[]; references: string[] }[];
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
export { validateResourceGraph as validateBoardResourceGraph } from './resource_contract';

/** Claims must be produced by a validated binding adapter, not UI strings. */
export function analyzeHardwareResources(graph: BoardResourceGraph, claims: ResourceClaim[], missingDeclarations = 0): ResourceAnalysis {
  const safe = validateBoardResourceGraph(graph);
  const resources = new Map(safe.resources.map(r => [r.id, r]));
  const result: ResourceAnalysis = { coverage: safe.coverage, bindings: [], conflicts: [], gaps: [], usages: [] };
  if (claims.length > 4096) throw new Error('resource_claim.limit');
  if (missingDeclarations) result.gaps.push({ code: 'missing-declarations' });
  const claimIds = new Set<string>();
  const expanded: ResourceClaim[] = [];
  for (const claim of claims) {
    expanded.push(claim);
    const routes = safe.routes.filter(r => r.resource === claim.resource);
    for (const signal of Object.keys(claim.signals ?? {})) if (!routes.some(r => r.signal === signal)) result.gaps.push({ code: 'unknown-signal', claim: claim.id });
    for (const route of routes) {
      const pin = claim.signals?.[route.signal] ?? (route.mode === 'fixed' ? route.pins[0] : undefined);
      if (!pin || !route.pins.includes(pin)) { result.gaps.push({ code: 'unresolved-route', claim: claim.id, resource: claim.resource }); continue; }
      // Bus consumers share the same signal owner, not a generic GPIO role.
      expanded.push({ id: `binding:${expanded.length}`, owner: `signal:${claim.resource}:${route.signal}`, reference: claim.reference, resource: pin, role: `${claim.resource}.${route.signal}` });
    }
  }
  // Synthetic binding IDs cannot collide with caller claim IDs.
  const inputIds = new Set(claims.map(c => c.id));
  let synthetic = 0;
  for (const claim of expanded) {
    if (!claims.includes(claim)) {
      while (inputIds.has(`binding:${synthetic}`)) synthetic++;
      claim.id = `binding:${synthetic++}`;
    }
    if (!idPattern.test(claim.id) || claimIds.has(claim.id)) throw new Error('resource_claim.id');
    claimIds.add(claim.id);
    const resource = resources.get(claim.resource);
    if (!resource) { result.gaps.push({ code: 'unbound-resource', claim: claim.id }); continue; }
    const ancestors: string[] = [];
    let parent = resource.parent;
    while (parent) { ancestors.push(parent); parent = resources.get(parent)!.parent; }
    result.bindings.push({ claim, resource, ancestors });
    if (resource.sharing === 'unknown' || !resource.evidence.length) result.gaps.push({ code: 'resource-coverage', resource: resource.id });
    if (resource.evidence.some(id => safe.evidence.find(e => e.id === id)?.confidence === 'unknown')) result.gaps.push({ code: 'unknown-evidence', resource: resource.id });
    if ((resource.sharing === 'address' || resource.sharing === 'selector') && (!claim.discriminator || (resource.sharing === 'address' && !claim.segment))) result.gaps.push({ code: 'missing-discriminator-or-segment', claim: claim.id });
    if (resource.sharing === 'configuration' && !resource.configurationKeys?.length) result.gaps.push({ code: 'missing-configuration-policy', resource: resource.id });
    for (const key of resource.configurationKeys ?? []) if (claim.configuration?.[key] === undefined) result.gaps.push({ code: 'unknown-configuration', claim: claim.id });
    if (resource.reserved) result.conflicts.push({ code: 'reserved-resource', resource: resource.id, claims: [claim.id] });
  }
  for (const resource of safe.resources) {
    const direct = result.bindings.filter(b => b.resource.id === resource.id);
    const all = result.bindings.filter(b => b.resource.id === resource.id || b.ancestors.includes(resource.id));
    if (direct.length) result.usages.push({ resource: resource.id, roles: [...new Set(direct.map(b => b.claim.role))], owners: [...new Set(direct.map(b => b.claim.owner))], references: [...new Set(direct.map(b => b.claim.reference))] });
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i].claim, b = all[j].claim;
      if (a.owner === b.owner && a.role === b.role && a.resource === b.resource && a.discriminator === b.discriminator && a.segment === b.segment && JSON.stringify(a.configuration ?? {}) === JSON.stringify(b.configuration ?? {})) continue;
      const directPair = a.resource === resource.id && b.resource === resource.id;
      let code: string | undefined;
      if ((a.resource === resource.id && a.exclusive) || (b.resource === resource.id && b.exclusive) || (directPair && resource.sharing === 'exclusive')) code = 'exclusive-conflict';
      else if (directPair && (resource.sharing === 'address' || resource.sharing === 'selector')) {
        if (!a.discriminator || !b.discriminator || (resource.sharing === 'address' && (!a.segment || !b.segment))) result.gaps.push({ code: 'missing-discriminator-or-segment', resource: resource.id });
        else if (a.discriminator === b.discriminator && (resource.sharing !== 'address' || a.segment === b.segment)) code = 'discriminator-conflict';
      }
      if (resource.configurationKeys?.length) {
        for (const key of resource.configurationKeys) {
          const av = a.configuration?.[key], bv = b.configuration?.[key];
          if (av === undefined || bv === undefined) result.gaps.push({ code: 'unknown-configuration', resource: resource.id });
          else if (av !== bv) code = 'configuration-conflict';
        }
      } else if (resource.sharing === 'configuration') result.gaps.push({ code: 'missing-configuration-policy', resource: resource.id });
      if (directPair) {
        for (const route of safe.routes.filter(r => r.resource === resource.id)) {
          const ap = a.signals?.[route.signal] ?? (route.mode === 'fixed' ? route.pins[0] : undefined);
          const bp = b.signals?.[route.signal] ?? (route.mode === 'fixed' ? route.pins[0] : undefined);
          if (ap && bp && ap !== bp) code = 'route-conflict';
        }
      }
      if (code) result.conflicts.push({ code, resource: resource.id, claims: [a.id, b.id] });
    }
  }
  if (result.gaps.length && result.coverage === 'full') result.coverage = 'partial';
  if (!safe.resources.length) result.coverage = 'unknown';
  return result;
}
