import type { BlockSearchEntry } from '../types/library';
import type { HardwareResourceInspectorView } from '../services/hardware_resource_inspector';

export function describeBlockDiscovery(entry: BlockSearchEntry, view?: HardwareResourceInspectorView | null) {
    const resources = [...new Set(entry.hardware?.resources?.map(resource => resource.kind) ?? [])];
    // Existing Inspector projection only. A controller's presence is capability,
    // NOT a route selection, free-resource assertion, or compatibility decision.
    const buses = view ? [
        ...view.buses.filter(bus => bus.kind !== 'other' && resources.includes(bus.kind)),
        ...(resources.includes('uart') ? view.uarts : []),
    ].map(bus => bus.id) : [];
    return {
        resources,
        boards: entry.hardware?.boards ?? [],
        architectures: entry.hardware?.architectures ?? [],
        dependencies: (entry.dependencies ?? []).filter(item => !item.optional).map(item => item.id),
        controllers: [...new Set(buses)],
        context: !view ? 'unresolved' : resources.length === 0 ? 'undeclared' : 'review',
    } as const;
}
