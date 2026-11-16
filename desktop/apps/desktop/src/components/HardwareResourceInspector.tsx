import { useMemo } from 'react';
import { Cable, CircleAlert, CircleCheck, Cpu, Gauge, GitBranch, LocateFixed, Network, Radio, Usb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { resourceCoverageState, resourceRoleLabel } from './resource_presentation';
import type { WorkspaceViewMode } from '../services/workspace_view_mode';
import type {
    HardwareResourceInspectorView,
    InspectorBusView,
    InspectorConflictTrace,
    InspectorPinView,
    InspectorResourceTrace,
    InspectorRouteView,
    InspectorTimerView,
    InspectorUartView,
} from '../services/hardware_resource_inspector';

interface HardwareResourceInspectorProps {
    view: HardwareResourceInspectorView | null;
    compact?: boolean;
    displayMode?: WorkspaceViewMode;
    onLocateBlock?: (blockId: string) => void;
}

function routeLabel(route: InspectorRouteView): string {
    const pins = route.selectedPins.length > 0
        ? route.selectedPins
        : route.fixedPin
            ? [route.fixedPin]
            : [];
    const suffix = pins.length > 0 ? ` · ${pins.join(', ')}` : '';
    return `${route.signal}${suffix}`;
}

function pinLabel(pin: InspectorPinView): string {
    const named = pin.aliases.find(alias => /^GPIO/i.test(alias));
    if (named) return named;
    const numeric = pin.aliases.find(alias => /^\d+$/.test(alias));
    if (numeric) return `GPIO${numeric}`;
    return pin.id.replace(/^gpio\./i, 'GPIO');
}

function statusClass(status: string): string {
    if (status === 'conflict') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300';
    if (status === 'partial') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-300';
    if (status === 'unknown' || status === 'reserved') return 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400';
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-300';
}

function statusKey(status: string): string {
    if (status === 'conflict') return 'resourceInspector.status.conflict';
    if (status === 'reserved') return 'resourceInspector.status.reserved';
    if (status === 'unknown') return 'resourceInspector.status.unknown';
    if (status === 'normal-sharing') return 'resourceInspector.status.normalSharing';
    if (status === 'shared-bus') return 'resourceInspector.status.sharedBus';
    return 'resourceInspector.noConflict';
}

function coverageValueKey(value: string): string {
    return `resourceInspector.coverageValue.${value}`;
}

function evidenceValueKey(value: string): string {
    return `resourceInspector.evidenceValue.${value}`;
}

function conflictLabel(code: string, t: (key: string, options?: Record<string, unknown>) => string): string {
    return t(`resourceInspector.conflictCode.${code}`, { defaultValue: code });
}

function conflictDetail(
    code: string,
    field: 'reason' | 'impact' | 'suggestion',
    t: (key: string, options?: Record<string, unknown>) => string,
): string {
    return t(`resourceInspector.conflictDetails.${code}.${field}`, {
        defaultValue: t(`resourceInspector.conflictDefaults.${field}`),
    });
}

function locateReference(reference: string): string {
    const value = String(reference || '').trim();
    return value.startsWith('block:') ? value.slice('block:'.length) : value;
}

function uniqueReferences(values: string[]): string[] {
    return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function referenceLabel(reference: string, t: (key: string, options?: Record<string, unknown>) => string): string {
    return `${t('resourceInspector.locateBlock')}: ${reference}`;
}

function TraceLocateButton({
    reference,
    t,
    onLocateBlock,
    role = 'resource-conflict-locate',
    label,
}: {
    reference: string;
    t: (key: string, options?: Record<string, unknown>) => string;
    onLocateBlock?: (blockId: string) => void;
    role?: string;
    label?: string;
}) {
    const normalized = locateReference(reference);
    if (!normalized || !onLocateBlock) return null;
    return (
        <button
            type="button"
            data-ck-role={role}
            data-block-id={normalized}
            className="inline-flex max-w-full items-center gap-1.5 rounded border border-brand-200 bg-brand-50 px-2 py-1 text-[11px] font-semibold text-brand-700 hover:bg-brand-100 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-brand-900 dark:bg-brand-950/45 dark:text-brand-300 dark:hover:bg-brand-950/70"
            title={referenceLabel(reference, t)}
            onClick={() => onLocateBlock(normalized)}
        >
            <LocateFixed size={10} aria-hidden="true" />
            <span className="min-w-0 break-words">{label || t('resourceInspector.locateBlock')}</span>
        </button>
    );
}

function routeList(routes: InspectorRouteView[], t: (key: string, options?: Record<string, unknown>) => string) {
    if (routes.length === 0) return <span className="text-slate-400">{t('resourceInspector.none')}</span>;
    return (
        <div className="flex flex-wrap gap-1">
            {routes.map(route => (
                <span key={route.id} className="max-w-full break-all rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300" title={route.mode === 'selectable' ? t('resourceInspector.selectableRoute') : t('resourceInspector.fixedRoute')}>
                    {routeLabel(route)}{route.mode === 'selectable' ? ' · ↔' : ''}
                </span>
            ))}
        </div>
    );
}

function PinCard({ pin, t, onLocateBlock }: { pin: InspectorPinView; t: (key: string, options?: Record<string, unknown>) => string; onLocateBlock?: (blockId: string) => void }) {
    const usage = pin.currentUsage;
    return (
        <article data-ck-role="resource-pin" data-resource-id={pin.id} className={`min-w-0 rounded border px-2.5 py-2 ${pin.conflicts.length > 0 ? 'border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/25' : usage.length > 0 ? 'border-sky-200 bg-sky-50/60 dark:border-sky-900 dark:bg-sky-950/25' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'}`}>
            <div className="flex min-w-0 items-start gap-1.5">
                <span className="min-w-0 flex-1 break-all font-mono text-xs font-bold text-slate-800 dark:text-slate-100">{pinLabel(pin)}</span>
                <span data-ck-role="pin-status" className={`max-w-[60%] rounded border px-1.5 py-0.5 text-[10px] font-semibold ${statusClass(pin.conflicts.length > 0 ? 'conflict' : pin.status === 'reserved' ? 'reserved' : pin.coverage !== 'full' ? pin.coverage : pin.status)}`}>
                    {pin.conflicts.length > 0 ? t('resourceInspector.conflict') : pin.status === 'reserved' ? t(statusKey(pin.status)) : pin.coverage !== 'full' ? t('experience.' + pin.coverage) : usage.length > 0 ? t('resourceInspector.inUse') : t('resourceInspector.none')}
                </span>
            </div>
            <div className="mt-1.5 grid gap-1 text-[11px] leading-4 text-slate-600 dark:text-slate-300">
                <div data-ck-role="pin-current-usage"><span className="font-semibold">{t('resourceInspector.currentUsage')}: </span>{usage.length > 0 ? uniqueReferences(usage.map(item => resourceRoleLabel(item.role, t))).join(t('listSeparator')) : t('resourceInspector.none')}</div>
                {usage.length > 0 && <div className="flex flex-wrap items-center justify-between gap-1">
                    <span>{t('resourceInspector.references')}: {pin.referenceCount}</span>
                    {uniqueReferences(pin.references).map(reference => <TraceLocateButton key={reference} reference={reference} t={t} onLocateBlock={onLocateBlock} role="resource-pin-locate" />)}
                </div>}
                {pin.conflicts.length > 0 && <div className="text-red-700 dark:text-red-300">{pin.conflicts.map(conflict => conflictLabel(conflict.code, t)).join(t('listSeparator'))}</div>}
            </div>
            <details className="mt-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400" data-ck-role="pin-capability-details">
                <summary className="cursor-pointer">{t('experience.details')}</summary>
                <div className="mt-1 break-all font-mono">{pin.id}</div>
                <div className="mt-1"><span className="font-semibold">{t('resourceInspector.capabilityStep')}: </span>{pin.capabilities.join(t('listSeparator'))}</div>
                <div><span className="font-semibold">{t('resourceInspector.relatedResources')}: </span>{routeList(pin.relatedResources, t)}</div>
            </details>
        </article>
    );
}

function BusCard({
    bus,
    t,
    onLocateBlock,
}: {
    bus: InspectorBusView;
    t: (key: string, options?: Record<string, unknown>) => string;
    onLocateBlock?: (blockId: string) => void;
}) {
    return (
        <details
            className="rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
            data-ck-role="hardware-resource-bus"
            data-resource-id={bus.id}
        >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 [&::-webkit-details-marker]:hidden">
                <Cable size={12} className="shrink-0 text-brand-600 dark:text-brand-300" />
                <div className="min-w-0 flex-1">
                    <div className="break-all font-mono text-xs font-bold text-slate-800 dark:text-slate-100">{bus.aliases[0] || bus.id}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{bus.devices.length ? t('experience.deviceCount', { count: bus.devices.length }) : t('experience.noDevices')}</div>
                </div>
                <span className={`max-w-[50%] rounded border px-1.5 py-0.5 text-[10px] font-semibold ${statusClass(bus.conflicts.length > 0 ? 'conflict' : bus.status === 'reserved' ? 'reserved' : bus.coverage !== 'full' ? bus.coverage : bus.status)}`}>{bus.conflicts.length > 0 ? t('resourceInspector.conflict') : bus.status === 'reserved' ? t(statusKey(bus.status)) : bus.coverage !== 'full' ? t('experience.' + bus.coverage) : bus.devices.length ? t(statusKey(bus.status)) : t('resourceInspector.none')}</span>
            </summary>
            <div className="border-t border-slate-100 px-2 py-2 text-[11px] leading-5 text-slate-600 dark:border-slate-800 dark:text-slate-300" data-ck-role="hardware-resource-bus-details">
                <div><span className="font-semibold">{t('resourceInspector.signals')}: </span>{routeList(bus.signals, t)}</div>
                <div className="mt-1"><span className="font-semibold">{t('resourceInspector.devices')}: </span>{bus.devices.length > 0 ? (
                    <span className="inline-flex flex-wrap gap-1 align-middle">
                        {bus.devices.map(device => (
                            <span key={`${device.claimId || device.reference}:${device.address || ''}`} className="inline-flex max-w-full flex-wrap items-center gap-1 rounded bg-slate-50 px-1 py-0.5 dark:bg-slate-800">
                                <span className="min-w-0 break-all" title={device.reference}>
                                    <span className="block font-semibold">{device.reference}</span>
                                    {resourceRoleLabel(device.role, t)}{device.address ? ` · ${device.address}` : ''}{Object.keys(device.signals).length > 0 ? ` · ${Object.entries(device.signals).map(([signal, pin]) => `${signal}=${pin}`).join(', ')}` : ''}
                                </span>
                                <TraceLocateButton reference={device.reference} t={t} onLocateBlock={onLocateBlock} role="resource-bus-locate" />
                            </span>
                        ))}
                    </span>
                ) : t('resourceInspector.none')}</div>
                {bus.currentUsage.length > 0 && <div className="mt-1"><span className="font-semibold">{t('resourceInspector.currentUsage')}: </span>{bus.currentUsage.map(item => `${item.role}${item.reference ? ` · ${item.reference}` : ''}`).join(t('listSeparator'))}</div>}
                {bus.conflicts.length > 0 && <div className="mt-1 text-red-700 dark:text-red-300"><span className="font-semibold">{t('resourceInspector.conflict')}: </span>{bus.conflicts.map(conflict => conflictLabel(conflict.code, t)).join(t('listSeparator'))}</div>}
            </div>
        </details>
    );
}

function ConflictCard({
    trace,
    t,
    onLocateBlock,
}: {
    trace: InspectorConflictTrace;
    t: (key: string, options?: Record<string, unknown>) => string;
    onLocateBlock?: (blockId: string) => void;
}) {
    const references = uniqueReferences([
        ...trace.blockReferences,
        ...trace.claims.map(claim => claim.reference),
    ]);
    return (
        <article
            className="min-w-0 rounded border border-red-200 bg-red-50/70 px-3 py-2.5 dark:border-red-900/70 dark:bg-red-950/25"
            data-ck-role="hardware-resource-conflict-card"
            data-resource-id={trace.resourceId}
        >
            <div className="flex min-w-0 items-start gap-1.5">
                <CircleAlert size={12} className="mt-0.5 shrink-0 text-red-600 dark:text-red-300" />
                <div className="min-w-0 flex-1">
                    <div className="break-words text-xs font-bold text-red-800 dark:text-red-200">{t('experience.conflictTitle')}</div>
                    <div className="mt-1 break-all font-mono text-[11px] text-red-700 dark:text-red-300">{trace.resourceId}</div>
                </div>
                <span className="shrink-0 rounded border border-red-300 px-1 py-0.5 text-[8px] font-bold text-red-700 dark:border-red-800 dark:text-red-300">{t('resourceInspector.conflict')}</span>
            </div>
            {trace.claims.length > 0 && <div className="mt-2 text-[11px] text-red-700 dark:text-red-300">{uniqueReferences(trace.claims.map(claim => resourceRoleLabel(claim.role, t))).join(' + ')}</div>}
            <div className="mt-2 grid gap-1 text-[11px] leading-5 text-red-700 dark:text-red-300" data-ck-role="resource-conflict-explanation">
                <div><span className="font-semibold">{t('resourceInspector.reason')}: </span>{conflictDetail(trace.conflict.code, 'reason', t)}</div>
                <div><span className="font-semibold">{t('resourceInspector.impact')}: </span>{conflictDetail(trace.conflict.code, 'impact', t)}</div>
                <div><span className="font-semibold">{t('resourceInspector.suggestion')}: </span>{conflictDetail(trace.conflict.code, 'suggestion', t)}</div>
            </div>
            {references.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                    {references.map(reference => <TraceLocateButton key={reference} reference={reference} t={t} onLocateBlock={onLocateBlock} label={t('experience.locateSource', { role: resourceRoleLabel(trace.claims.find(claim => claim.reference === reference)?.role || reference, t) })} />)}
                </div>
            ) : <div className="mt-1 text-[11px] text-red-700 dark:text-red-300">{t('resourceInspector.referencesNone')}</div>}
            <details className="mt-2 break-words text-[11px] leading-5 text-slate-600 dark:text-slate-300">
                <summary className="cursor-pointer">{t('experience.details')}</summary>
                <div>{conflictLabel(trace.conflict.code, t)}</div>
                <div>{t('resourceInspector.capabilityStep')}: {trace.capabilities.join(t('listSeparator'))}</div>
                <div>{t('resourceInspector.conflictClaims')}: {trace.claims.map(claim => `${claim.id} · ${claim.reference}`).join(t('listSeparator'))}</div>
                <div>{t('resourceInspector.bindingStep')}: {trace.bindings.map(binding => `${binding.claimId} → ${binding.resource}`).join(t('listSeparator'))}</div>
                <div className="break-all">{t('resourceInspector.conflictEvidence')}: {trace.evidence.length ? trace.evidence.map(item => `${item.source}${item.locator ? ` · ${item.locator}` : ''}`).join(t('listSeparator')) : t('resourceInspector.evidenceNone')}</div>
            </details>
        </article>
    );
}

function TraceCard({
    trace,
    t,
    onLocateBlock,
}: {
    trace: InspectorResourceTrace;
    t: (key: string, options?: Record<string, unknown>) => string;
    onLocateBlock?: (blockId: string) => void;
}) {
    const references = uniqueReferences(trace.blockReferences);
    const bindings = trace.bindings;
    return (
        <details
            className="rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
            data-ck-role="hardware-resource-trace"
            data-resource-id={trace.resourceId}
        >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 [&::-webkit-details-marker]:hidden">
                <GitBranch size={11} className="shrink-0 text-violet-600 dark:text-violet-300" />
                <div className="min-w-0 flex-1">
                    <div className="break-all font-mono text-[10px] font-bold text-slate-800 dark:text-slate-100">{trace.aliases[0] || trace.resourceId}</div>
                    <div className="break-all text-[8px] text-slate-400">{trace.resourceId}</div>
                </div>
                <span className={`rounded border px-1 py-0.5 text-[8px] font-bold ${statusClass(trace.conflicts.length > 0 ? 'conflict' : trace.status)}`}>{t(statusKey(trace.conflicts.length > 0 ? 'conflict' : trace.status))}</span>
            </summary>
            <div className="break-all border-t border-slate-100 px-2 py-2 text-[11px] leading-5 text-slate-600 dark:border-slate-800 dark:text-slate-300">
                <ol className="grid gap-1" data-ck-role="resource-trace-path">
                    <li data-ck-role="resource-trace-node"><span className="font-semibold">{t('resourceInspector.capabilityStep')}: </span>{trace.capabilities.length > 0 ? trace.capabilities.join(t('listSeparator')) : t('resourceInspector.none')}</li>
                    <li data-ck-role="resource-trace-node"><span className="font-semibold">{t('resourceInspector.currentUsage')}: </span>{trace.currentUsage.length > 0 ? trace.currentUsage.map(item => `${item.role}${item.reference ? ` · ${item.reference}` : ''}`).join(t('listSeparator')) : t('resourceInspector.none')}</li>
                    <li data-ck-role="resource-trace-node"><span className="font-semibold">{t('resourceInspector.claimStep')}: </span>{trace.claims.length > 0 ? trace.claims.map(claim => `${claim.role}${claim.reference ? ` · ${claim.reference}` : ''}`).join(t('listSeparator')) : t('resourceInspector.claimNone')}</li>
                    <li data-ck-role="resource-trace-node"><span className="font-semibold">{t('resourceInspector.bindingStep')}: </span>{bindings.length > 0 ? bindings.map(binding => `${binding.resource}${binding.direct ? '' : ` · ${t('resourceInspector.inherited')}`}`).join(t('listSeparator')) : t('resourceInspector.none')}</li>
                    {bindings.some(binding => binding.ancestors.length > 0) && <li data-ck-role="resource-trace-node"><span className="font-semibold">{t('resourceInspector.ancestorStep')}: </span>{uniqueReferences(bindings.flatMap(binding => binding.ancestors)).join(t('listSeparator'))}</li>}
                    <li data-ck-role="resource-trace-node"><span className="font-semibold">{t('resourceInspector.referenceStep')}: </span>{references.length > 0 ? references.join(t('listSeparator')) : t('resourceInspector.referencesNone')}</li>
                    <li data-ck-role="resource-trace-node"><span className="font-semibold">{t('resourceInspector.conflict')}: </span>{trace.conflicts.length > 0 ? trace.conflicts.map(conflict => conflictLabel(conflict.code, t)).join(t('listSeparator')) : t('resourceInspector.none')}</li>
                    <li data-ck-role="resource-trace-node"><span className="font-semibold">{t('resourceInspector.evidenceStep')}: </span>{trace.evidence.length > 0 ? trace.evidence.map(item => `${item.source}${item.locator ? ` · ${item.locator}` : ''}`).join(t('listSeparator')) : t('resourceInspector.evidenceNone')}</li>
                </ol>
                {references.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{references.map(reference => <TraceLocateButton key={reference} reference={reference} t={t} onLocateBlock={onLocateBlock} role="resource-trace-locate" />)}</div>}
            </div>
        </details>
    );
}

function UartCard({ uart, t }: { uart: InspectorUartView; t: (key: string, options?: Record<string, unknown>) => string }) {
    return (
        <article className="rounded border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center gap-1.5">
                <Radio size={12} className="shrink-0 text-indigo-600 dark:text-indigo-300" />
                <div className="min-w-0 flex-1">
                    <div className="break-all font-mono text-[10px] font-bold text-slate-800 dark:text-slate-100">{uart.aliases[0] || uart.id}</div>
                    <div className="break-all text-[8px] text-slate-400">{uart.id}</div>
                </div>
                <span className={`max-w-[50%] rounded border px-1 py-0.5 text-[10px] font-semibold ${statusClass(uart.conflicts.length > 0 ? 'conflict' : uart.status === 'reserved' ? 'reserved' : uart.coverage !== 'full' ? uart.coverage : uart.status)}`}>{uart.conflicts.length > 0 ? t('resourceInspector.conflict') : uart.status === 'reserved' ? t(statusKey(uart.status)) : uart.coverage !== 'full' ? t('experience.' + uart.coverage) : t(statusKey(uart.status))}</span>
            </div>
            <div className="mt-1 grid gap-0.5 break-all text-[11px] leading-5 text-slate-600 dark:text-slate-300">
                <div><span className="font-semibold">RX: </span>{uart.rx || t('resourceInspector.unresolved')}</div>
                <div><span className="font-semibold">TX: </span>{uart.tx || t('resourceInspector.unresolved')}</div>
                <div><span className="font-semibold">{t('resourceInspector.usedBy')}: </span>{uart.usedBy.length > 0 ? uart.usedBy.map(item => item.reference).join(t('listSeparator')) : t('resourceInspector.none')}</div>
            </div>
        </article>
    );
}

function TimerCard({ timer, t }: { timer: InspectorTimerView; t: (key: string, options?: Record<string, unknown>) => string }) {
    const status = timer.conflicts.length > 0 ? 'conflict' : timer.status === 'reserved' ? 'reserved' : timer.coverage !== 'full' ? timer.coverage : timer.allocation !== 'static' ? 'unknown' : timer.status;
    return (
        <article className="rounded border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center gap-1.5">
                <Gauge size={12} className="shrink-0 text-amber-600 dark:text-amber-300" />
                <div className="min-w-0 flex-1">
                    <div className="break-all font-mono text-[10px] font-bold text-slate-800 dark:text-slate-100">{timer.aliases[0] || timer.id}</div>
                    <div className="break-all text-[8px] text-slate-400">{timer.id}</div>
                </div>
                <span className={`max-w-[50%] rounded border px-1 py-0.5 text-[10px] font-semibold ${statusClass(status)}`}>{status === 'partial' ? t('experience.partial') : t(statusKey(status))}</span>
            </div>
            <div className="mt-1 break-words text-[11px] leading-5 text-slate-600 dark:text-slate-300">
                <div><span className="font-semibold">{t('resourceInspector.consumers')}: </span>{timer.consumers.length > 0 ? timer.consumers.map(item => `${resourceRoleLabel(item.role, t)}${item.assignedChannel ? ` · ${item.assignedChannel}` : ''}`).join(t('listSeparator')) : t('resourceInspector.none')}</div>
                <div className="mt-1"><span className="font-semibold">{t('resourceInspector.allocation')}: </span>{timer.allocation === 'dynamic-unresolved' ? t('resourceInspector.dynamicUnresolved') : timer.allocation === 'static' ? t('resourceInspector.static') : t('resourceInspector.unresolved')}</div>
                {timer.conflicts.length > 0 && <div className="mt-1 text-red-700 dark:text-red-300"><span className="font-semibold">{t('resourceInspector.conflict')}: </span>{timer.conflicts.map(conflict => conflictLabel(conflict.code, t)).join(t('listSeparator'))}</div>}
            </div>
        </article>
    );
}

export function HardwareResourceInspector({ view, compact = false, displayMode = 'engineering', onLocateBlock }: HardwareResourceInspectorProps) {
    const { t: translate } = useTranslation('health');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const simple = displayMode === 'simple';
    const usedPins = useMemo(() => view?.pins.filter(pin => pin.currentUsage.length > 0 || pin.conflicts.length > 0) ?? [], [view]);
    const visiblePins = compact || simple ? usedPins : (view?.pins ?? []);
    const unusedPins = view?.pins.filter(pin => !usedPins.includes(pin)) ?? [];
    const visibleTraces = view ? view.resourceTraces : [];
    const validation = view?.coverage.hardwareValidation
        || (view?.coverage.hardwareEvidence === 'source-verified-not-hardware-tested' ? 'not-tested' : undefined);

    if (!view) return null;
    const coverageState = resourceCoverageState(view.coverage);
    const summaryState = view.conflicts.length > 0 ? 'conflict' : coverageState !== 'full' ? coverageState : view.gaps.length > 0 ? 'partial' : 'normal';

    return (
        <section className="mx-2 mt-2 min-w-0 shrink-0 bg-white/95 dark:bg-slate-900/90" data-ck-role="hardware-resource-inspector">
            <header className="flex items-center gap-2 border-b border-brand-100 px-3 py-2 dark:border-brand-950">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-100 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300"><Network size={15} /></span>
                <div className="min-w-0 flex-1">
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">{t('resourceInspector.title')}</h3>
                    <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{t('resourceInspector.readOnly')}</p>
                </div>
                <span data-ck-role="resource-inspector-conclusion" data-status={summaryState} className={`max-w-[50%] rounded border px-1.5 py-0.5 text-[11px] font-semibold ${statusClass(summaryState)}`}>
                    {view.conflicts.length > 0 ? t('resourceInspector.conflictsCount', { count: view.conflicts.length }) : summaryState === 'normal' ? t('resourceInspector.noConflict') : t('experience.' + summaryState)}
                </span>
            </header>

            <dl className="grid min-w-0 gap-2 px-3 py-3 text-[11px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))' }} data-ck-role="resource-coverage-summary">
                <div><dt className="text-slate-500 dark:text-slate-400">{t('experience.coverage')}</dt><dd className="mt-0.5 font-semibold text-slate-800 dark:text-slate-100">{t('experience.' + coverageState)}</dd></div>
                <div><dt className="text-slate-500 dark:text-slate-400">{t('experience.hardwareSource')}</dt><dd className="mt-0.5 font-semibold text-slate-800 dark:text-slate-100">{t(evidenceValueKey(view.coverage.hardwareEvidence || view.coverage.evidence.status), { defaultValue: view.coverage.hardwareEvidence || view.coverage.evidence.status })}</dd></div>
                <div><dt className="text-slate-500 dark:text-slate-400">{t('experience.hardwareTest')}</dt><dd className="mt-0.5 font-semibold text-slate-800 dark:text-slate-100">{validation ? t(evidenceValueKey(validation), { defaultValue: validation }) : t('resourceInspector.coverage.notReported')}</dd></div>
            </dl>
            <details className="px-3 pb-2 text-[11px] text-slate-500 dark:text-slate-400" data-ck-role="resource-coverage-details">
            <summary className="cursor-pointer">{t('experience.details')}</summary>
            <div className="flex flex-wrap gap-1 py-2 text-[10px] text-slate-600 dark:text-slate-300">
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-800">{t('resourceInspector.coverage.graph')}: {t(coverageValueKey(view.coverage.graph), { defaultValue: view.coverage.graph })}</span>
                {view.coverage.analysis && <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-800">{t('resourceInspector.coverage.analysis')}: {t(coverageValueKey(view.coverage.analysis), { defaultValue: view.coverage.analysis })}</span>}
                {view.coverage.declaration && <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-800">{t('resourceInspector.coverage.declaration')}: {t(coverageValueKey(view.coverage.declaration), { defaultValue: view.coverage.declaration })}</span>}
                {view.coverage.project && <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-800">{t('resourceInspector.coverage.project')}: {t(coverageValueKey(view.coverage.project), { defaultValue: view.coverage.project })}</span>}
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-800">{t('resourceInspector.coverage.evidence')}: {t(evidenceValueKey(view.coverage.evidence.status), { defaultValue: view.coverage.evidence.status })}</span>
                {view.coverage.hardwareEvidence && <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-800">{t('resourceInspector.coverage.hardwareEvidence')}: {t(evidenceValueKey(view.coverage.hardwareEvidence), { defaultValue: view.coverage.hardwareEvidence })}</span>}
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-800">{t('resourceInspector.coverage.hardwareValidation')}: {validation ? t(evidenceValueKey(validation), { defaultValue: validation }) : t('resourceInspector.coverage.notReported')}</span>
            </div>
            </details>

            {view.conflictTraces.length > 0 && (
                <section className="border-t border-red-100 px-2.5 py-2 dark:border-red-950/60" data-ck-role="hardware-resource-conflicts">
                    <div className="mb-1 text-[10px] font-bold text-red-800 dark:text-red-200">{t('resourceInspector.conflicts')}</div>
                    <div className="grid gap-1.5">{view.conflictTraces.map(trace => <ConflictCard key={`${trace.resourceId}:${trace.conflict.code}`} trace={trace} t={t} onLocateBlock={onLocateBlock} />)}</div>
                </section>
            )}

            {visiblePins.length > 0 && (
                <details open className="border-t border-slate-100 dark:border-slate-800">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200">{t(compact || simple ? 'experience.usedPins' : 'resourceInspector.pins')} · {visiblePins.length}</summary>
                    <div className="grid min-w-0 gap-1.5 px-2.5 pb-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))' }}>
                        {visiblePins.map(pin => <PinCard key={pin.id} pin={pin} t={t} onLocateBlock={onLocateBlock} />)}
                    </div>
                </details>
            )}
            {(compact || simple) && unusedPins.length > 0 && (
                <details className="border-t border-slate-100 dark:border-slate-800" data-ck-role="unused-resource-pins">
                    <summary className="cursor-pointer px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">{t('experience.unusedPins', { count: unusedPins.length })}</summary>
                    <div className="grid min-w-0 gap-1.5 px-2.5 pb-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))' }}>
                        {unusedPins.map(pin => <PinCard key={pin.id} pin={pin} t={t} onLocateBlock={onLocateBlock} />)}
                    </div>
                </details>
            )}

            {view.buses.length > 0 && (
                <details open={!simple || view.buses.some(bus => bus.devices.length > 0 || bus.conflicts.length > 0)} className="border-t border-slate-100 dark:border-slate-800">
                    <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold text-slate-700 dark:text-slate-200">{t('resourceInspector.buses')} · {view.buses.length}</summary>
                    <div className="grid gap-1.5 px-2.5 pb-2">{view.buses.map(bus => <BusCard key={bus.id} bus={bus} t={t} onLocateBlock={onLocateBlock} />)}</div>
                </details>
            )}

            {view.uarts.length > 0 && (
                <details open={!compact && !simple} className="border-t border-slate-100 dark:border-slate-800">
                    <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold text-slate-700 dark:text-slate-200">{t('resourceInspector.uarts')} · {view.uarts.length}</summary>
                    <div className="grid gap-1.5 px-2.5 pb-2">{view.uarts.map(uart => <UartCard key={uart.id} uart={uart} t={t} />)}</div>
                </details>
            )}

            {view.usbSerialJtag.length > 0 && (
                <details open={!compact && !simple} className="border-t border-slate-100 dark:border-slate-800">
                    <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold text-slate-700 dark:text-slate-200"><Usb size={11} className="mr-1 inline" />{t('resourceInspector.usbSerialJtag')} · {view.usbSerialJtag.length}</summary>
                    <div className="grid gap-1.5 px-2.5 pb-2">
                        {view.usbSerialJtag.map(controller => <article key={controller.id} className="rounded border border-slate-200 bg-white px-2 py-1.5 text-[9px] dark:border-slate-700 dark:bg-slate-900"><div className="font-mono font-bold text-slate-800 dark:text-slate-100">{controller.aliases[0] || controller.id}</div><div className="mt-1"><span className="font-semibold">{t('resourceInspector.signals')}: </span>{routeList(controller.signals, t)}</div><div className="mt-1"><span className="font-semibold">{t('resourceInspector.usedBy')}: </span>{controller.currentUsage.length > 0 ? controller.currentUsage.map(item => item.reference).join(t('listSeparator')) : t('resourceInspector.none')}</div></article>)}
                    </div>
                </details>
            )}

            {view.timers.length > 0 && (
                <details open={!compact && !simple} className="border-t border-slate-100 dark:border-slate-800">
                    <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold text-slate-700 dark:text-slate-200"><Cpu size={11} className="mr-1 inline" />{t('resourceInspector.timers')} · {view.timers.length}</summary>
                    <div className="grid min-w-0 gap-1.5 px-2.5 pb-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))' }}>{view.timers.map(timer => <TimerCard key={timer.id} timer={timer} t={t} />)}</div>
                </details>
            )}
            {visibleTraces.length > 0 && (
                <details className="border-t border-slate-100 dark:border-slate-800" data-ck-role="hardware-resource-traces">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200">{t('resourceInspector.resourceTraces')} · {visibleTraces.length}</summary>
                    <div className="grid gap-1.5 px-2.5 pb-2">{visibleTraces.map(trace => <TraceCard key={trace.resourceId} trace={trace} t={t} onLocateBlock={onLocateBlock} />)}</div>
                </details>
            )}

            {view.gaps.length > 0 && <div className="border-t border-amber-100 px-3 py-2 text-[9px] text-amber-700 dark:border-amber-950 dark:text-amber-300"><CircleAlert size={11} className="mr-1 inline" />{t('resourceInspector.gaps', { count: view.gaps.length })}</div>}
            {view.conflicts.length === 0 && <div className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400"><CircleCheck size={11} className="mr-1 inline" />{t('resourceInspector.noConflictDetail')}</div>}
            <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-1.5 text-[8px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <span>{t('resourceInspector.counts', view.counts)}</span>
                <span><GitBranch size={10} className="mr-1 inline" />{t('resourceInspector.readOnly')}</span>
            </div>
        </section>
    );
}

export default HardwareResourceInspector;
