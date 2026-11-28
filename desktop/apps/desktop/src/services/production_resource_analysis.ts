import { analyzeAvrWorkspaceResources } from './avr_builtin_resource_claims';
import { analyzeEsp32WorkspaceResources } from './esp32_builtin_resource_claims';
import { analyzeDeclaredHardware, type ResourceBlock, type ResourceCatalogEntry } from './resource_claim_binding';
import { validateResourceGraph } from './resource_contract';
import { compatLiteralField } from './blockly_compat_analysis';
import type { BoardResourceGraph } from './hardware_resource_graph';

/** Optional, presentation-only context for a validated third-party board.
 *
 * The compiler-resolved identity remains the only identity used by the
 * production bridge.  A package graph is supplied explicitly by the already
 * selected/validated board package; it is never inferred from a display name
 * or from generated C++.
 */
export interface ProductionResourceContext {
  boardResourceGraph?: unknown;
  catalog?: ResourceCatalogEntry[];
}

/** Convert the existing hydrated library metadata into the generic claim
 * adapter's narrow catalog shape.  This is deliberately a projection: no
 * package code is executed and no package identity is changed.
 */
export function resourceCatalogFromLibraries(libraries: readonly unknown[]): ResourceCatalogEntry[] {
  const result: ResourceCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of libraries) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const library = candidate as Record<string, unknown>;
    const manifest = library.block_manifest && typeof library.block_manifest === 'object' && !Array.isArray(library.block_manifest)
      ? library.block_manifest as Record<string, unknown>
      : undefined;
    const libraryId = typeof library.id === 'string' && library.id.trim()
      ? library.id.trim()
      : typeof manifest?.id === 'string' ? manifest.id : undefined;
    const manifestVersion = manifest?.schema_version === 2 ? 'v2' : 'v1-adapted';
    const rawEntries = Array.isArray(library.block_search_entries)
      ? library.block_search_entries
      : Array.isArray(manifest?.blocks) ? manifest.blocks : [];
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const type = typeof entry.type === 'string' ? entry.type.trim() : '';
      if (!type || seen.has(type)) continue;
      const fields = Array.isArray(entry.fields)
        ? entry.fields.flatMap(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string'
          ? [{ name: String((item as Record<string, unknown>).name) }]
          : [])
        : undefined;
      const inputs = Array.isArray(entry.inputs)
        ? entry.inputs.flatMap(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string'
          ? [{ name: String((item as Record<string, unknown>).name) }]
          : [])
        : undefined;
      const hardware = entry.hardware && typeof entry.hardware === 'object' && !Array.isArray(entry.hardware)
        ? { claims: (entry.hardware as Record<string, unknown>).claims }
        : undefined;
      seen.add(type);
      result.push({
        type,
        library_id: typeof entry.library_id === 'string' ? entry.library_id : libraryId,
        metadata_source: entry.metadata_source === 'v2' || entry.metadata_source === 'v1-adapted'
          ? entry.metadata_source
          : manifestVersion,
        ...(fields?.length ? { fields } : {}),
        ...(inputs?.length ? { inputs } : {}),
        ...(hardware && hardware.claims !== undefined ? { hardware } : {}),
      });
    }
  }
  return result;
}

/** Only the completed native compile's property observation may enter this bridge.
 * No display names, board defaults, generator parsing or local board resolution.
 */
export function analyzeProductionResolvedResources(
  value: unknown,
  workspace: { getAllBlocks(ordered: boolean): ResourceBlock[] },
  context?: ProductionResourceContext,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (['fqbn', 'mcu', 'variant', 'coreVersion', 'fCpu'].some(k => typeof v[k] !== 'string')) return null;
  if (!v.options || typeof v.options !== 'object' || Array.isArray(v.options)) return null;
  if (Object.values(v.options).some(x => typeof x !== 'string')) return null;
  const identity = {
    fqbn: v.fqbn as string, mcu: v.mcu as string, variant: v.variant as string,
    coreVersion: v.coreVersion as string, fCpu: v.fCpu as string,
    options: { ...v.options } as Record<string, string>,
  };
  // A third-party board is intentionally selected by an explicit, validated
  // package graph. This keeps the generic claim/binding/analyzer path the same
  // as the built-in models without adding a board-name or FQBN special case.
  if (context?.boardResourceGraph !== undefined) {
    let graph: BoardResourceGraph;
    try {
      graph = validateResourceGraph(context.boardResourceGraph);
    } catch {
      return { status: 'unavailable' as const, reason: 'invalid-board-resource-graph' };
    }
    // Blockly exposes literal/selector helper blocks in getAllBlocks(). They
    // are operands, not hardware consumers; the first-party adapters apply
    // the same filtering before entering the generic claim boundary.
    const pure = new Set([
      'math_number', 'text', 'logic_boolean', 'board_pin_selector',
      'serial_baudrate_selector', 'io_level', 'controls_global_defs_custom',
      'controls_setup_custom', 'controls_loop_custom', 'macro_define_custom',
      'code_include_custom', 'code_comment_custom',
    ]);
    const declared = analyzeDeclaredHardware(
      { resource_graph: graph },
      context.catalog ?? [],
      workspace.getAllBlocks(false).filter(block => !pure.has(block.type) && !compatLiteralField(block)),
    );
    return {
      status: 'ready' as const,
      model: { status: 'ready' as const, identity, resource_graph: graph },
      claims: declared.claims,
      gaps: declared.gaps,
      report: declared.report,
      coverage: {
        declarationCoverage: declared.gaps.length ? 'partial' as const : 'full' as const,
        analysisCoverage: declared.report?.gaps.length ? 'partial' as const : 'full' as const,
        hardwareEvidence: 'source-verified-not-hardware-tested' as const,
        projectCoverage: declared.gaps.length ? 'partial' as const : 'full' as const,
      },
    };
  }
  // The resolved compiler observation is the only dispatch input. Display
  // names and board catalog metadata never select a resource model. Every
  // identity from the ESP32 package enters the same generic claims adapter;
  // the identity-selected family model returns not-applicable for an
  // unsupported future MCU instead of being guessed as AVR or C3.
  const isEsp32Package = identity.fqbn.split(':').slice(0, 2).join(':') === 'esp32:esp32';
  if (isEsp32Package) {
    return analyzeEsp32WorkspaceResources(identity, workspace, context?.catalog);
  }
  return analyzeAvrWorkspaceResources(identity, workspace, context?.catalog);
}
