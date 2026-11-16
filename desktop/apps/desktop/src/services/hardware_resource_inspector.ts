/**
 * Read-only presentation adapter for the Hardware Resource Graph.
 *
 * This module deliberately contains no board knowledge and no analysis.  It
 * turns an already-built graph and an already-computed ResourceAnalysis into
 * stable, UI-friendly records.  In particular, capability (what a resource
 * can do) is kept separate from currentUsage (what claims currently bind it).
 *
 * Do not persist this view, feed it back into the compiler, or use it to make
 * allocation decisions.  The graph/analysis objects remain the source of
 * truth; this is only a display projection.
 */
import type {
  BoardResourceGraph,
  HardwareResource,
  ResourceAnalysis,
  ResourceBinding,
  ResourceClaim,
  ResourceCoverage,
  ResourceEvidence,
  ResourceRoute,
} from './hardware_resource_graph';

export type InspectorStatus = 'none' | 'conflict' | 'reserved' | 'unknown';
export type InspectorBusKind = 'i2c' | 'spi' | 'other';

export interface InspectorConflict {
  code: string;
  resource: string;
  claims: string[];
}

export interface InspectorUsage {
  claimId?: string;
  reference: string;
  owner: string;
  role: string;
  resource: string;
  discriminator?: string;
  signals: Record<string, string>;
}

export interface InspectorRouteView {
  id: string;
  resource: string;
  signal: string;
  mode: ResourceRoute['mode'];
  /** All legal graph pins.  This is not an allocation result. */
  pins: string[];
  /** Selected pins from an existing claim, if one exists. */
  selectedPins: string[];
  /** A fixed route's pin; selectable routes intentionally have no guess. */
  fixedPin?: string;
}

export interface InspectorPinView {
  id: string;
  aliases: string[];
  /** Static capabilities from the graph only. */
  capabilities: string[];
  /** Current claims bound directly to this GPIO. */
  currentUsage: InspectorUsage[];
  references: string[];
  referenceCount: number;
  relatedResources: InspectorRouteView[];
  conflicts: InspectorConflict[];
  status: InspectorStatus;
  coverage: ResourceCoverage;
}

export interface InspectorBusDevice {
  claimId?: string;
  reference: string;
  owner: string;
  role: string;
  /** Existing normalized address/discriminator, never inferred by the UI. */
  address?: string;
  segment?: string;
  signals: Record<string, string>;
}

export interface InspectorBusView {
  id: string;
  type: string;
  kind: InspectorBusKind;
  aliases: string[];
  sharing: HardwareResource['sharing'];
  signals: InspectorRouteView[];
  devices: InspectorBusDevice[];
  currentUsage: InspectorUsage[];
  conflicts: InspectorConflict[];
  status: InspectorStatus | 'normal-sharing' | 'shared-bus';
  coverage: ResourceCoverage;
}

export interface InspectorUartView extends InspectorBusView {
  kind: 'other';
  rx?: string;
  tx?: string;
  usedBy: InspectorUsage[];
}

export interface InspectorUsbSerialJtagView {
  id: string;
  type: string;
  aliases: string[];
  signals: InspectorRouteView[];
  currentUsage: InspectorUsage[];
  conflicts: InspectorConflict[];
  status: InspectorStatus;
  coverage: ResourceCoverage;
}

export type InspectorAllocation = 'static' | 'dynamic-unresolved' | 'unresolved';

export interface InspectorTimerConsumer {
  claimId?: string;
  reference: string;
  owner: string;
  role: string;
  resource: string;
  /** Present only when the graph/claim explicitly selected a channel. */
  assignedChannel?: string;
}

export interface InspectorTimerView {
  id: string;
  type: string;
  parent?: string;
  aliases: string[];
  capabilities: string[];
  consumers: InspectorTimerConsumer[];
  conflicts: InspectorConflict[];
  status: InspectorStatus;
  allocation: InspectorAllocation;
  coverage: ResourceCoverage;
}

export interface InspectorEvidenceSummary {
  total: number;
  verified: number;
  declared: number;
  unknown: number;
  status: ResourceEvidence['confidence'] | 'none';
}

/** Optional richer coverage emitted by production resource analysis. */
export interface InspectorCoverageInput {
  declarationCoverage?: ResourceCoverage;
  analysisCoverage?: ResourceCoverage;
  projectCoverage?: ResourceCoverage;
  hardwareEvidence?: string;
  hardwareValidation?: string;
}

/** Claim-adapter gaps are presentation evidence, not a second analysis pass. */
export interface InspectorGap {
  code: string;
  claim?: string;
  resource?: string;
  block?: string;
}

export interface InspectorCoverageView {
  graph: ResourceCoverage;
  analysis?: ResourceCoverage;
  declaration?: ResourceCoverage;
  project?: ResourceCoverage;
  hardwareEvidence?: string;
  hardwareValidation?: string;
  evidence: InspectorEvidenceSummary;
}

/** A copied claim suitable for a read-only trace view. */
export interface InspectorClaimTrace {
  id: string;
  owner: string;
  reference: string;
  resource: string;
  role: string;
  exclusive?: boolean;
  discriminator?: string;
  segment?: string;
  configuration: Record<string, string | number | boolean>;
  signals: Record<string, string>;
}

/** One analysis binding, retaining parent traversal and direct/inherited scope. */
export interface InspectorBindingTrace {
  claimId: string;
  resource: string;
  ancestors: string[];
  direct: boolean;
  claim: InspectorClaimTrace;
}

export interface InspectorTraceUsage extends InspectorUsage {
  /** False when this usage reaches a parent resource through a child binding. */
  direct: boolean;
}

export interface InspectorEvidenceTrace {
  id: string;
  source: string;
  locator?: string;
  confidence: ResourceEvidence['confidence'];
}

/**
 * A complete, presentation-only chain for one graph resource:
 * resource -> capability/current usage -> claim -> binding -> reference -> conflict.
 */
export interface InspectorResourceTrace {
  resourceId: string;
  type: string;
  aliases: string[];
  sharing: HardwareResource['sharing'];
  reserved: boolean;
  capabilities: string[];
  currentUsage: InspectorTraceUsage[];
  claims: InspectorClaimTrace[];
  bindings: InspectorBindingTrace[];
  blockReferences: string[];
  evidence: InspectorEvidenceTrace[];
  conflicts: InspectorConflict[];
  status: InspectorStatus;
}

/** Conflict-focused projection; no new conflict is inferred here. */
export interface InspectorConflictTrace {
  conflict: InspectorConflict;
  resourceId: string;
  resourceType?: string;
  capabilities: string[];
  evidence: InspectorEvidenceTrace[];
  claims: InspectorClaimTrace[];
  bindings: InspectorBindingTrace[];
  blockReferences: string[];
}

export interface HardwareResourceInspectorInput {
  graph: BoardResourceGraph;
  analysis?: ResourceAnalysis | null;
  /** Optional explicit claims are useful for callers that retain them apart from report.bindings. */
  claims?: ResourceClaim[];
  /** Optional gaps emitted by the existing claim adapter (for example dynamic LEDC allocation). */
  gaps?: InspectorGap[];
  /** Alias for callers that retain claim-adapter gaps under a descriptive name. */
  claimGaps?: InspectorGap[];
  coverage?: InspectorCoverageInput;
}

export interface HardwareResourceInspectorView {
  pins: InspectorPinView[];
  buses: InspectorBusView[];
  uarts: InspectorUartView[];
  usbSerialJtag: InspectorUsbSerialJtagView[];
  timers: InspectorTimerView[];
  coverage: InspectorCoverageView;
  conflicts: InspectorConflict[];
  /** Per-resource trace chains; additive presentation field. */
  resourceTraces: InspectorResourceTrace[];
  /** One trace record for each existing analyzer conflict. */
  conflictTraces: InspectorConflictTrace[];
  /** Short alias for consumers that call the records simply "traces". */
  traces: InspectorResourceTrace[];
  gaps: InspectorGap[];
  counts: {
    resources: number;
    routes: number;
    claims: number;
    bindings: number;
    conflicts: number;
  };
}

const EMPTY_SIGNALS: Record<string, string> = {};

function copySignals(signals: Record<string, string> | undefined): Record<string, string> {
  return signals ? { ...signals } : {};
}

function claimUsage(binding: ResourceBinding): InspectorUsage {
  const claim = binding.claim;
  return {
    claimId: claim.id,
    reference: claim.reference,
    owner: claim.owner,
    role: claim.role,
    resource: binding.resource.id,
    ...(claim.discriminator !== undefined ? { discriminator: claim.discriminator } : {}),
    signals: copySignals(claim.signals),
  };
}

function claimTrace(claim: ResourceClaim): InspectorClaimTrace {
  return {
    id: claim.id,
    owner: claim.owner,
    reference: claim.reference,
    resource: claim.resource,
    role: claim.role,
    ...(claim.exclusive !== undefined ? { exclusive: claim.exclusive } : {}),
    ...(claim.discriminator !== undefined ? { discriminator: claim.discriminator } : {}),
    ...(claim.segment !== undefined ? { segment: claim.segment } : {}),
    configuration: { ...(claim.configuration ?? {}) },
    signals: copySignals(claim.signals),
  };
}

function evidenceTrace(evidence: ResourceEvidence): InspectorEvidenceTrace {
  return {
    id: evidence.id,
    source: evidence.source,
    ...(evidence.locator !== undefined ? { locator: evidence.locator } : {}),
    confidence: evidence.confidence,
  };
}

function bindingTrace(binding: ResourceBinding, direct: boolean): InspectorBindingTrace {
  return {
    claimId: binding.claim.id,
    resource: binding.resource.id,
    ancestors: [...binding.ancestors],
    direct,
    claim: claimTrace(binding.claim),
  };
}

/** The analyzer emits synthetic route bindings with `binding:*` IDs.  Keep
 * their physical pin binding visible, but mark them non-direct in the trace
 * so the chain still distinguishes the original bus claim from its derived
 * route observation. */
function isSyntheticRouteClaim(claim: ResourceClaim): boolean {
  return claim.id.startsWith('binding:') && claim.owner.startsWith('signal:');
}

function declaredBindingDirect(binding: ResourceBinding, resourceId: string): boolean {
  return binding.resource.id === resourceId && !isSyntheticRouteClaim(binding.claim);
}

function traceUsage(binding: ResourceBinding, direct: boolean): InspectorTraceUsage {
  return { ...claimUsage(binding), direct };
}

function uniqueClaims(claims: InspectorClaimTrace[]): InspectorClaimTrace[] {
  const seen = new Set<string>();
  return claims.filter(claim => !seen.has(claim.id) && (seen.add(claim.id), true));
}

function uniqueBindings(bindings: InspectorBindingTrace[]): InspectorBindingTrace[] {
  const seen = new Set<string>();
  return bindings.filter(binding => !seen.has(binding.claimId) && (seen.add(binding.claimId), true));
}

function routeView(route: ResourceRoute, bindings: ResourceBinding[]): InspectorRouteView {
  const selectedPins = bindings
    .filter(binding => binding.claim.resource === route.resource)
    .flatMap(binding => {
      const selected = binding.claim.signals?.[route.signal];
      if (selected !== undefined) return [selected];
      return route.mode === 'fixed' && route.pins[0] ? [route.pins[0]] : [];
    });
  return {
    id: route.id,
    resource: route.resource,
    signal: route.signal,
    mode: route.mode,
    pins: [...route.pins],
    selectedPins: [...new Set(selectedPins)],
    ...(route.mode === 'fixed' && route.pins[0] ? { fixedPin: route.pins[0] } : {}),
  };
}

function statusFor(resource: HardwareResource, conflicts: InspectorConflict[]): InspectorStatus {
  if (resource.reserved || conflicts.some(conflict => conflict.resource === resource.id && conflict.code === 'reserved-resource')) return 'reserved';
  if (conflicts.some(conflict => conflict.resource === resource.id)) return 'conflict';
  if (resource.sharing === 'unknown' || !resource.evidence.length) return 'unknown';
  return 'none';
}

function resourceKind(resource: HardwareResource): InspectorBusKind {
  if (resource.type === 'i2c-controller') return 'i2c';
  if (resource.type === 'spi-controller') return 'spi';
  return 'other';
}

function isBusResource(resource: HardwareResource): boolean {
  return resource.type === 'i2c-controller' || resource.type === 'spi-controller';
}

function isTimerResource(resource: HardwareResource): boolean {
  return resource.type.includes('timer')
    || resource.type === 'ledc-controller'
    || resource.type === 'ledc-channel'
    || resource.type === 'pwm-channel'
    || resource.type === 'mcpwm-controller'
    || resource.type === 'mcpwm-operator';
}

function isUsbResource(resource: HardwareResource): boolean {
  return resource.type === 'usb-serial-jtag-controller';
}

function evidenceSummary(evidence: ResourceEvidence[]): InspectorEvidenceSummary {
  const summary = { total: evidence.length, verified: 0, declared: 0, unknown: 0, status: 'none' as InspectorEvidenceSummary['status'] };
  for (const item of evidence) summary[item.confidence]++;
  summary.status = summary.unknown > 0 ? 'unknown' : summary.declared > 0 ? 'declared' : summary.verified > 0 ? 'verified' : 'none';
  return summary;
}

function directBindings(resourceId: string, bindings: ResourceBinding[]): ResourceBinding[] {
  return bindings.filter(binding => binding.resource.id === resourceId);
}

function descendants(resourceId: string, resources: Map<string, HardwareResource>): Set<string> {
  const ids = new Set<string>([resourceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const resource of resources.values()) {
      if (resource.parent && ids.has(resource.parent) && !ids.has(resource.id)) {
        ids.add(resource.id);
        changed = true;
      }
    }
  }
  return ids;
}

function timerAllocation(resource: HardwareResource, usages: InspectorUsage[], gaps: InspectorGap[]): InspectorAllocation {
  if (gaps.some(gap => gap.code === 'dynamic-ledc-channel-unresolved'
    && (gap.resource === resource.id || (!gap.resource && resource.type === 'ledc-controller')))) return 'dynamic-unresolved';
  if (resource.capabilities?.some(capability => capability.includes('dynamic-channel-allocation') || capability === 'dynamic-channel')) {
    return usages.length ? 'dynamic-unresolved' : 'unresolved';
  }
  return usages.length ? 'static' : 'unresolved';
}

/**
 * Project an existing graph/analysis into read-only Inspector data.
 * No values are inferred beyond fixed graph routes and explicit claims.
 */
export function buildHardwareResourceInspector(input: HardwareResourceInspectorInput): HardwareResourceInspectorView {
  const { graph, analysis = null } = input;
  const effectiveCoverage: ResourceCoverage = analysis?.coverage ?? graph.coverage;
  const resources = new Map(graph.resources.map(resource => [resource.id, resource]));
  const bindings = analysis?.bindings ?? [];
  const conflicts: InspectorConflict[] = (analysis?.conflicts ?? []).map(conflict => ({ ...conflict, claims: [...conflict.claims] }));
  // Keep claim-adapter gaps visible without re-running or changing analysis.
  // ResourceAnalysis gaps are already normalized; adapter gaps may additionally
  // carry a block id for a concrete unresolved claim.
  const gaps: InspectorGap[] = [
    ...(analysis?.gaps ?? []),
    ...(input.gaps ?? []),
    ...(input.claimGaps ?? []),
  ].map(gap => ({ ...gap }));
  const allClaims = input.claims ?? bindings.map(binding => binding.claim);
  const claimCount = new Set(allClaims.map(claim => claim.id)).size;
  const evidenceById = new Map(graph.evidence.map(item => [item.id, item]));
  const claimById = new Map<string, ResourceClaim>();
  for (const claim of allClaims) claimById.set(claim.id, claim);
  for (const binding of bindings) claimById.set(binding.claim.id, binding.claim);

  const pins: InspectorPinView[] = graph.resources.filter(resource => resource.type === 'gpio').map(resource => {
    const usageBindings = directBindings(resource.id, bindings);
    const usage = usageBindings.map(claimUsage);
    const related = graph.routes.filter(route => route.pins.includes(resource.id)).map(route => routeView(route, bindings));
    const references = [...new Set(usage.map(item => item.reference))];
    return {
      id: resource.id,
      aliases: [...(resource.aliases ?? [])],
      capabilities: [...(resource.capabilities ?? [])],
      currentUsage: usage,
      references,
      referenceCount: references.length,
      relatedResources: related,
      conflicts: conflicts.filter(conflict => conflict.resource === resource.id),
      status: statusFor(resource, conflicts),
      coverage: effectiveCoverage,
    };
  });

  const makeBus = (resource: HardwareResource): InspectorBusView => {
    const direct = directBindings(resource.id, bindings);
    const usage = direct.map(claimUsage);
    const resourceConflicts = conflicts.filter(conflict => conflict.resource === resource.id);
    // A verified controller initialization proves usage, not a device, CS or
    // address. Keep its trace/currentUsage without inventing a connected device.
    const devices = direct.filter(binding => !binding.claim.role.endsWith('-controller-use')).map(binding => ({
      claimId: binding.claim.id,
      reference: binding.claim.reference,
      owner: binding.claim.owner,
      role: binding.claim.role,
      ...(binding.claim.discriminator !== undefined ? { address: binding.claim.discriminator } : {}),
      ...(binding.claim.segment !== undefined ? { segment: binding.claim.segment } : {}),
      signals: copySignals(binding.claim.signals),
    }));
    const status = statusFor(resource, conflicts);
    return {
      id: resource.id,
      type: resource.type,
      kind: resourceKind(resource),
      aliases: [...(resource.aliases ?? [])],
      sharing: resource.sharing,
      signals: graph.routes.filter(route => route.resource === resource.id).map(route => routeView(route, bindings)),
      devices,
      currentUsage: usage,
      conflicts: resourceConflicts,
      status: status !== 'none' ? status : resource.sharing === 'address' ? 'normal-sharing' : 'shared-bus',
      coverage: effectiveCoverage,
    };
  };
  const buses = graph.resources.filter(isBusResource).map(makeBus);

  const makeUart = (resource: HardwareResource): InspectorUartView => {
    const base = makeBus(resource);
    const signals = base.signals;
    const pinFor = (name: string) => {
      const signal = signals.find(item => item.signal === name);
      return signal?.selectedPins[0] ?? signal?.fixedPin;
    };
    return { ...base, kind: 'other', rx: pinFor('rx'), tx: pinFor('tx'), usedBy: base.currentUsage };
  };
  const uarts = graph.resources.filter(resource => resource.type === 'uart-controller').map(makeUart);

  const usbSerialJtag = graph.resources.filter(isUsbResource).map(resource => {
    const direct = directBindings(resource.id, bindings);
    const resourceConflicts = conflicts.filter(conflict => conflict.resource === resource.id);
    return {
      id: resource.id,
      type: resource.type,
      aliases: [...(resource.aliases ?? [])],
      signals: graph.routes.filter(route => route.resource === resource.id).map(route => routeView(route, bindings)),
      currentUsage: direct.map(claimUsage),
      conflicts: resourceConflicts,
      status: statusFor(resource, conflicts),
      coverage: effectiveCoverage,
    };
  });

  const timers = graph.resources.filter(isTimerResource).map(resource => {
    const ids = descendants(resource.id, resources);
    const resourceBindings = bindings.filter(binding => ids.has(binding.resource.id));
    const consumers = resourceBindings.map(binding => {
      const assignedChannel = binding.resource.type === 'ledc-channel' || binding.resource.type === 'pwm-channel' ? binding.resource.id : undefined;
      return {
        claimId: binding.claim.id,
        reference: binding.claim.reference,
        owner: binding.claim.owner,
        role: binding.claim.role,
        resource: binding.resource.id,
        ...(assignedChannel ? { assignedChannel } : {}),
      };
    });
    const resourceConflicts = conflicts.filter(conflict => ids.has(conflict.resource));
    const status = resourceConflicts.some(conflict => conflict.code === 'reserved-resource') ? 'reserved' : resourceConflicts.length ? 'conflict' : statusFor(resource, conflicts);
    return {
      id: resource.id,
      type: resource.type,
      ...(resource.parent ? { parent: resource.parent } : {}),
      aliases: [...(resource.aliases ?? [])],
      capabilities: [...(resource.capabilities ?? [])],
      consumers,
      conflicts: resourceConflicts,
      status,
      allocation: timerAllocation(resource, consumers.map(consumer => ({ ...consumer, signals: EMPTY_SIGNALS, resource: consumer.resource })), gaps),
      coverage: effectiveCoverage,
    };
  });

  // Build trace records after all source projections are available.  These
  // records are deliberately derived from bindings and graph evidence only;
  // they never infer a route, claim, or conflict that the analyzer did not
  // already provide.
  const resourceTraces: InspectorResourceTrace[] = graph.resources.map(resource => {
    const relatedIds = descendants(resource.id, resources);
    const relatedBindings = bindings.filter(binding => relatedIds.has(binding.resource.id));
    const traceBindings = uniqueBindings(relatedBindings.map(binding => bindingTrace(binding, declaredBindingDirect(binding, resource.id))));
    const traceClaims = uniqueClaims([
      ...traceBindings.map(binding => binding.claim),
      ...allClaims.filter(claim => claim.resource === resource.id).map(claimTrace),
    ]);
    const currentUsage = relatedBindings.map(binding => traceUsage(binding, binding.resource.id === resource.id));
    const resourceConflicts = conflicts.filter(conflict => relatedIds.has(conflict.resource));
    const traceEvidence = resource.evidence
      .map(id => evidenceById.get(id))
      .filter((item): item is ResourceEvidence => item !== undefined)
      .map(evidenceTrace);
    const blockReferences = [...new Set([
      ...currentUsage.map(usage => usage.reference),
      ...traceClaims.map(claim => claim.reference),
    ])];
    const status: InspectorStatus = resourceConflicts.some(conflict => conflict.code === 'reserved-resource')
      ? 'reserved'
      : resourceConflicts.length > 0
        ? 'conflict'
        : statusFor(resource, conflicts);
    return {
      resourceId: resource.id,
      type: resource.type,
      aliases: [...(resource.aliases ?? [])],
      sharing: resource.sharing,
      reserved: resource.reserved === true,
      capabilities: [...(resource.capabilities ?? [])],
      currentUsage,
      claims: traceClaims,
      bindings: traceBindings,
      blockReferences,
      evidence: traceEvidence,
      conflicts: resourceConflicts,
      status,
    };
  });

  const conflictTraces: InspectorConflictTrace[] = conflicts.map(conflict => {
    const conflictResource = resources.get(conflict.resource);
    const relatedIds = conflictResource ? descendants(conflictResource.id, resources) : new Set([conflict.resource]);
    const relatedBindings = bindings.filter(binding => relatedIds.has(binding.resource.id));
    const traceBindings = uniqueBindings(relatedBindings.map(binding => bindingTrace(binding, declaredBindingDirect(binding, conflict.resource))));
    const traceClaims = uniqueClaims([
      ...conflict.claims.map(id => claimById.get(id)).filter((claim): claim is ResourceClaim => claim !== undefined).map(claimTrace),
      ...traceBindings.map(binding => binding.claim),
    ]);
    const traceEvidence = conflictResource
      ? conflictResource.evidence
        .map(id => evidenceById.get(id))
        .filter((item): item is ResourceEvidence => item !== undefined)
        .map(evidenceTrace)
      : [];
    return {
      conflict: { ...conflict, claims: [...conflict.claims] },
      resourceId: conflict.resource,
      ...(conflictResource ? { resourceType: conflictResource.type } : {}),
      capabilities: [...(conflictResource?.capabilities ?? [])],
      evidence: traceEvidence,
      claims: traceClaims,
      bindings: traceBindings,
      blockReferences: [...new Set(traceClaims.map(claim => claim.reference))],
    };
  });

  const hardwareEvidence = input.coverage?.hardwareEvidence;
  const hardwareValidation = input.coverage?.hardwareValidation
    ?? (hardwareEvidence === 'source-verified-not-hardware-tested' ? 'not-tested' : undefined);
  const coverage: InspectorCoverageView = {
    graph: graph.coverage,
    ...(input.coverage?.analysisCoverage ? { analysis: input.coverage.analysisCoverage } : analysis ? { analysis: analysis.coverage } : {}),
    ...(input.coverage?.declarationCoverage ? { declaration: input.coverage.declarationCoverage } : {}),
    ...(input.coverage?.projectCoverage ? { project: input.coverage.projectCoverage } : {}),
    ...(hardwareEvidence ? { hardwareEvidence } : {}),
    ...(hardwareValidation ? { hardwareValidation } : {}),
    evidence: evidenceSummary(graph.evidence),
  };

  return {
    pins,
    buses,
    uarts,
    usbSerialJtag,
    timers,
    coverage,
    conflicts,
    resourceTraces,
    conflictTraces,
    traces: resourceTraces,
    gaps,
    counts: {
      resources: graph.resources.length,
      routes: graph.routes.length,
      claims: claimCount,
      bindings: bindings.length,
      conflicts: conflicts.length,
    },
  };
}

export default buildHardwareResourceInspector;
