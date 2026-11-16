/**
 * Opt-in, read-only recognition prototype over compiler-produced GIMPLE.
 * Not a C++ text scanner, package validator, Provider selector or runtime probe.
 * No package names, board names, pin values or driver entry points are built in.
 */
import { lookupCompileSourceMap, sha256Hex, resolveTrustedCompileDiagnosticFile } from './compile_source_map';
import type { CompileSourceMapV1, TrustedCompileSketchAliasV1 } from './compile_source_map';
import { analyzeHardwareResources } from './hardware_resource_graph';
import type { BoardResourceGraph, ResourceClaim } from './hardware_resource_graph';
import type { ProviderBoardContext } from './provider_resolution';

export interface CompilerSourceDigest { path: string; sha256: string }
export interface CompilerObservationUnit {
    file: string;
    kind: 'sketch' | 'library';
    /** From the successful build's selected library, never a name lookup. */
    libraryRoot?: string;
    libraryVersion?: string;
    gimple: string;
    gimpleSha256: string;
    /** Preprocessed by this exact command, not a header interpreted by CK. */
    preprocessed?: string;
    preprocessedSha256?: string;
    commandSha256: string;
    /** Compiler dependency output for this exact translation unit. */
    dependencies: string[];
    /** Demangled symbols from the actual selected compiler object (not text guesses). */
    definedSymbols: string[];
    referencedSymbols: string[];
}
export interface VerifiedPrimitiveApiEvidence {
    callee: string;
    kind: 'gpio-output' | 'gpio-input' | 'pin-mode' | 'adc' | 'pwm' | 'uart'
        | 'spi' | 'servo-attach' | 'interrupt-blocking' | 'tone';
    definitionFile: string;
    headerFile: string;
    sourceEvidence: CompilerSourceDigest[];
    definedSymbols: string[];
    context: ProviderBoardContext;
    receiverArgument?: number;
    valueArgument?: number;
    /** From the reviewed implementation compiled for this exact target. */
    timer?: string;
}
export interface CompilerTimingObservation {
    blockId: string;
    effect: 'interrupt-blocking' | 'interrupt-sensitive';
    implementation: string;
    steps: CompilerResourceTrace['steps'];
    evidence: CompilerSourceDigest[];
}
export interface CompilerResourceSnapshot {
    context: ProviderBoardContext;
    codeSha256: string;
    compileCommandsSha256: string;
    graphSha256: string;
    sources: CompilerSourceDigest[];
    compiledFiles: string[];
    units: CompilerObservationUnit[];
}
/** Internal, reviewed low-level API evidence, NOT new package metadata.
 * A symbol alone proves nothing. The selected implementation/header digests
 * and exact target must match before this summary can be used. */
export interface VerifiedI2cApiEvidence {
    callee: string;
    commitCallee: string;
    /** Reviewed methods that cannot replace the pending transaction address. */
    intermediateCallees: string[];
    receiver: string;
    receiverArgument: number;
    addressArgument: number;
    resourceAlias: string;
    definitionFile: string;
    headerFile: string;
    sourceEvidence: CompilerSourceDigest[];
    definedSymbols: string[];
    context: ProviderBoardContext;
}
export interface CompilerResourceObservationInput {
    snapshot: CompilerResourceSnapshot;
    current: {
        context?: ProviderBoardContext;
        code: string;
        compileCommandsSha256: string;
        sources: CompilerSourceDigest[];
    };
    sourceMap: Readonly<CompileSourceMapV1>;
    graph: BoardResourceGraph;
    apiEvidence: VerifiedI2cApiEvidence[];
    primitiveEvidence?: VerifiedPrimitiveApiEvidence[];
    /** Existing resolved board-model mappings, never guessed from a pin number. */
    mappings?: { pwm?: Record<string, string>; adc?: Record<string, string>; tone?: string };
    trustedSource?: { runId: string; alias: TrustedCompileSketchAliasV1 | null };
}
interface Location { file: string; line: number; column: number }
interface Statement { text: string; location?: Location }
interface FunctionBody {
    name: string;
    parameters: string[];
    statements: Statement[];
    unsupported: boolean;
    unit: CompilerObservationUnit;
}
interface Call { callee: string; arguments: string[]; location?: Location }
export interface CompilerResourceTrace {
    blockId: string;
    claimId: string;
    origin: 'compiler-observation';
    implementation: { file: string; libraryRoot: string; version?: string };
    steps: { function: string; file: string; line: number }[];
    apiEvidence: CompilerSourceDigest[];
    operation?: VerifiedPrimitiveApiEvidence['kind'];
}

const normalize = (path: string) => {
    const value = path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
    return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
};
const samePath = (left: string, right: string) => normalize(left) === normalize(right);
const digestPattern = /^[0-9a-f]{64}$/;
const symbolName = (symbol: string) => symbol.includes('(') ? symbol.slice(0, symbol.indexOf('(')) : symbol;
const locationPattern = /\[([^\]\r\n]+):(\d+):(\d+)\]/g;
const scalar = /^(?:uint(?:8|16|32)_t|int(?:8|16|32)_t|unsigned char|unsigned int|int|bool|char) ([A-Za-z_]\w*)$/;

function sameContext(left: ProviderBoardContext | undefined, right: ProviderBoardContext): boolean {
    return !!left && ['fqbn', 'mcu', 'variant', 'coreVersion', 'fCpu'].every(key => {
        const a = left[key as keyof ProviderBoardContext], b = right[key as keyof ProviderBoardContext];
        return typeof a === 'string' && a.length > 0 && a === b;
    }) && !!left.options && !!right.options
        && Object.keys(left.options).length === Object.keys(right.options).length
        && Object.entries(left.options).every(([key, value]) => right.options![key] === value);
}

function statement(line: string): Statement {
    const locations = [...line.matchAll(locationPattern)];
    const first = locations[0];
    return {
        text: line.replace(locationPattern, '').trim(),
        ...(first ? { location: { file: first[1], line: Number(first[2]), column: Number(first[3]) } } : {}),
    };
}

function parseFunctions(unit: CompilerObservationUnit): FunctionBody[] {
    const functions: FunctionBody[] = [];
    const lines = unit.gimple.split(/\r?\n/);
    let current: FunctionBody | undefined;
    let depth = 0;
    for (const line of lines) {
        const item = statement(line);
        if (!current) {
            // GCC's early tree format: "void fn(types) (typed parameters)".
            const match = item.text.match(/^[\w :*&]+? ([A-Za-z_][\w:]*)(?:\([^()]*\))? \(([^()]*)\)$/);
            if (!match) continue;
            const params = match[2] ? match[2].split(',').map(value => value.trim()) : [];
            current = {
                name: match[1], parameters: params.map(value => value.match(scalar)?.[1] ?? ''),
                statements: [], unsupported: params.some(value => !scalar.test(value)), unit,
            };
            continue;
        }
        if (item.text === '{') { depth++; if (depth > 1) current.unsupported = true; continue; }
        if (item.text === '}') {
            if (--depth === 0) { functions.push(current); current = undefined; }
            continue;
        }
        if (depth && item.text) current.statements.push(item);
    }
    return functions;
}

function parseCall(item: Statement): Call | undefined {
    const match = item.text.match(/^(?:[A-Za-z_][\w.]* = )?([A-Za-z_][\w:]*) \(([^()]*)\);$/);
    if (!match) return undefined;
    return {
        callee: match[1], arguments: match[2] ? match[2].split(',').map(value => value.trim()) : [],
        ...(item.location ? { location: item.location } : {}),
    };
}

/** Only straight-line or acyclic GCC goto CFGs. Unknown syntax fails closed.
 * A reported call must dominate every normal exit; branch-only calls are not
 * converted into unconditional resource claims. No C++ expression evaluation. */
function mandatoryStatements(body: FunctionBody): Set<number> | undefined {
    if (body.unsupported || body.statements.length > 2000) return undefined;
    const labels = new Map<string, number>();
    body.statements.forEach((item, i) => { if (/^<[\w.]+>:$/.test(item.text)) labels.set(item.text.slice(0, -1), i); });
    const edges: number[][] = [];
    const exit = body.statements.length;
    for (let i = 0; i < exit; i++) {
        const text = body.statements[i].text;
        const jump = text.match(/^goto (<[\w.]+>);$/);
        const branch = text.match(/^if \(.+\) goto (<[\w.]+>); else goto (<[\w.]+>);$/);
        if (jump || branch) {
            const targets = (branch ? [branch[1], branch[2]] : [jump![1]]).map(label => labels.get(label));
            if (targets.some(target => target === undefined || target <= i)) return undefined;
            edges[i] = targets as number[];
        } else if (/^return(?: [^;]+)?;$/.test(text)) {
            edges[i] = [exit];
        } else if (parseCall(body.statements[i]) || /^<[\w.]+>:$/.test(text)
            || text === 'GIMPLE_NOP'
            || /^(?:[A-Za-z_][\w.]*|[A-Za-z_]\w*\[[^\]]+\]) = [^;{}]+;$/.test(text)
            || /^(?:(?:static|const) )?[\w ]+(?: = [^;{}]+)?;$/.test(text)) {
            edges[i] = [i + 1];
        } else return undefined;
    }
    const reachable = (omit = -1) => {
        const visited = new Set<number>(), pending = [0];
        while (pending.length) {
            const node = pending.pop()!;
            if (node === omit || visited.has(node)) continue;
            visited.add(node);
            for (const target of edges[node] ?? []) pending.push(target);
        }
        return visited;
    };
    const reached = reachable();
    if (!reached.has(exit)) return undefined;
    return new Set([...reached].filter(index => index < exit && !reachable(index).has(exit)));
}

/** Scalars only, with no casts/arithmetic/alias/variable guessing. */
function argumentValue(token: string, parameters: Map<string, string>, body: FunctionBody): string | undefined {
    if (/^\d+$/.test(token) || /^&[A-Za-z_]\w*$/.test(token)) return token;
    if (!parameters.has(token)) return undefined;
    // Reassigned or address-taken parameters are not treated as invariant.
    if (body.statements.some(item => item.text.startsWith(`${token} = `)
        || new RegExp(`&${token}\\b`).test(item.text))) return undefined;
    return parameters.get(token);
}

export function observeCompilerResources(input: CompilerResourceObservationInput) {
    const gaps = new Set<string>(['recognition.coverage.partial', 'recognition.runtime-execution.not-verified']);
    const claims: ResourceClaim[] = [], traces: CompilerResourceTrace[] = [];
    const timing: CompilerTimingObservation[] = [];
    const unknown = (code: string) => {
        gaps.add(code);
        return { status: 'Unknown' as const, claims, traces, timing, gaps: [...gaps].sort(), analysis: null };
    };
    const snapshot = input.snapshot;
    if (!sameContext(input.current.context, snapshot.context)) return unknown('recognition.context.stale-or-missing');
    if (sha256Hex(input.current.code) !== snapshot.codeSha256
        || snapshot.codeSha256 !== input.sourceMap.codeSha256) return unknown('recognition.code.stale');
    if (!digestPattern.test(snapshot.compileCommandsSha256)
        || snapshot.compileCommandsSha256 !== input.current.compileCommandsSha256) return unknown('recognition.commands.stale');
    if (sha256Hex(JSON.stringify(input.graph)) !== snapshot.graphSha256) return unknown('recognition.graph.stale');
    if (!snapshot.sources.length || snapshot.sources.length > 4096 || snapshot.units.length > 256) {
        return unknown('recognition.evidence.invalid');
    }
    const currentHashes = new Map(input.current.sources.map(source => [normalize(source.path), source.sha256]));
    const hashes = new Map(snapshot.sources.map(source => [normalize(source.path), source.sha256]));
    if (hashes.size !== snapshot.sources.length || currentHashes.size !== input.current.sources.length
        || snapshot.sources.some(source => !digestPattern.test(source.sha256)
            || currentHashes.get(normalize(source.path)) !== source.sha256)) return unknown('recognition.source.stale');
    if (snapshot.units.some(unit => !hashes.has(normalize(unit.file))
        || !snapshot.compiledFiles.some(file => samePath(file, unit.file))
        || !digestPattern.test(unit.commandSha256) || sha256Hex(unit.gimple) !== unit.gimpleSha256
        || (unit.preprocessed !== undefined && sha256Hex(unit.preprocessed) !== unit.preprocessedSha256)
        || unit.gimple.length > 2_000_000 || unit.dependencies.some(file => !hashes.has(normalize(file))))) {
        return unknown('recognition.compiler-evidence.invalid');
    }
    const verified = (api: VerifiedI2cApiEvidence | VerifiedPrimitiveApiEvidence) => sameContext(api.context, snapshot.context)
        && api.sourceEvidence.length > 0
        && api.sourceEvidence.some(source => samePath(source.path, api.definitionFile))
        && api.sourceEvidence.some(source => samePath(source.path, api.headerFile))
        && snapshot.compiledFiles.some(file => samePath(file, api.definitionFile))
        && api.sourceEvidence.every(source => digestPattern.test(source.sha256)
            && hashes.get(normalize(source.path)) === source.sha256);
    const apiEvidence = input.apiEvidence.filter(verified);
    const primitiveEvidence = (input.primitiveEvidence ?? []).filter(verified);
    if (!apiEvidence.length && !primitiveEvidence.length) return unknown('recognition.api-evidence.unverified');
    const functions = snapshot.units.flatMap(parseFunctions);
    const roots = functions.filter(body => body.unit.kind === 'sketch' && body.parameters.length === 0
        && ['setup', 'loop'].includes(body.name));
    if (!roots.length) return unknown('recognition.entrypoint.unresolved');
    const seen = new Set<string>();
    const walk = (body: FunctionBody, values: string[], blockId: string, steps: CompilerResourceTrace['steps'], depth: number) => {
        if (depth > 12 || traces.length > 512) { gaps.add('recognition.traversal.limit'); return; }
        const mandatory = mandatoryStatements(body);
        if (!mandatory) { gaps.add('recognition.control-flow.unsupported'); return; }
        const parameters = new Map(body.parameters.map((param, index) => [param, values[index]]));
        for (let index = 0; index < body.statements.length; index++) {
            const call = parseCall(body.statements[index]);
            if (!call) continue;
            if (!mandatory.has(index)) { gaps.add('recognition.conditional-call.unresolved'); continue; }
            if (!call.location) { gaps.add('recognition.source-location.missing'); continue; }
            let reference = blockId;
            if (!reference) {
                const file = input.trustedSource ? resolveTrustedCompileDiagnosticFile({
                    ...input.trustedSource, sourceMap: input.sourceMap, diagnosticFile: call.location.file,
                }) : call.location.file;
                if (!file) { gaps.add('recognition.source-alias.unavailable'); continue; }
                const mapping = lookupCompileSourceMap(input.sourceMap, {
                    file, line: call.location.line, codeSha256: snapshot.codeSha256,
                    acceptedConfidences: ['exact', 'high'],
                });
                if (!mapping || mapping.section !== body.name) continue;
                reference = mapping.blockId;
            }
            const nextSteps = [...steps, { function: call.callee, file: call.location.file, line: call.location.line }];
            const arguments_ = call.arguments.map(token => argumentValue(token, parameters, body));
            const primitives = primitiveEvidence.filter(api => api.callee === call.callee
                && body.unit.dependencies.some(file => samePath(file, api.headerFile))
                && body.unit.referencedSymbols.filter(symbol => symbolName(symbol) === call.callee).length === 1
                && body.unit.referencedSymbols.some(symbol => symbolName(symbol) === call.callee && api.definedSymbols.includes(symbol)));
            if (primitives.length === 1) {
                const api = primitives[0];
                const token = arguments_[api.valueArgument ?? 0];
                const receiver = api.receiverArgument === undefined ? undefined : arguments_[api.receiverArgument];
                const findResource = (alias: string | undefined, type: string) => {
                    const matches = input.graph.resources.filter(resource => resource.type === type
                        && alias !== undefined && (resource.id === alias || resource.aliases?.includes(alias)));
                    return matches.length === 1 ? matches[0] : undefined;
                };
                const pin = token && /^\d+$/.test(token) ? findResource(token, 'gpio') : undefined;
                const emit = (resource: string | undefined, role: string, extra: Partial<ResourceClaim> = {}) => {
                    if (!resource || !input.graph.resources.some(item => item.id === resource)) {
                        gaps.add('recognition.resource.unresolved'); return;
                    }
                    const key = JSON.stringify([reference, resource, role, extra]);
                    if (seen.has(key)) return;
                    seen.add(key);
                    const claim: ResourceClaim = {
                        id: `compiler-observation:${claims.length}`, reference,
                        owner: `${role}.${resource.replace(/^gpio\./, '')}`, resource, role, ...extra,
                    };
                    claims.push(claim);
                    traces.push({
                        blockId: reference, claimId: claim.id, origin: 'compiler-observation',
                        implementation: { file: api.definitionFile, libraryRoot: body.unit.libraryRoot ?? '', version: body.unit.libraryVersion },
                        steps: nextSteps, apiEvidence: api.sourceEvidence,
                        operation: api.kind,
                    });
                };
                const effect = (value: CompilerTimingObservation['effect']) => {
                    if (!timing.some(item => item.blockId === reference && item.effect === value && item.implementation === api.definitionFile)) {
                        timing.push({ blockId: reference, effect: value, implementation: api.definitionFile, steps: nextSteps, evidence: api.sourceEvidence });
                    }
                };
                switch (api.kind) {
                    case 'gpio-input': emit(pin?.id, 'digital-input'); break;
                    case 'gpio-output': emit(pin?.id, 'digital-output'); break;
                    case 'pin-mode': {
                        const mode = arguments_[1];
                        if (mode === '1') emit(pin?.id, 'digital-output');
                        else if (mode === '0' || mode === '2') emit(pin?.id, 'digital-input');
                        else gaps.add('recognition.mode.unresolved');
                        break;
                    }
                    case 'adc': emit(token === undefined ? undefined : input.mappings?.adc?.[token], 'analog-read'); break;
                    case 'pwm': {
                        const duty = arguments_[1];
                        if (duty === '0' || duty === '255') emit(pin?.id, 'digital-output');
                        else if (duty && /^\d+$/.test(duty)) {
                            emit(token === undefined ? undefined : input.mappings?.pwm?.[token], 'hardware-pwm', { owner: `pwm.${token}` });
                        } else gaps.add('recognition.pwm.unresolved');
                        break;
                    }
                    case 'uart': {
                        const port = receiver?.replace(/^&/, '');
                        const resource = findResource(port, 'uart-controller');
                        if (token && /^\d+$/.test(token) && Number(token) > 0 && port) {
                            emit(resource?.id, 'hardware-uart', { owner: port, configuration: { baud: Number(token) } });
                        } else gaps.add('recognition.uart.unresolved');
                        break;
                    }
                    case 'spi': {
                        // A controller call proves controller usage, NOT device CS/topology.
                        const matches = input.graph.resources.filter(item => item.type === 'spi-controller');
                        emit(matches.length === 1 ? matches[0].id : undefined, 'spi-controller-use');
                        gaps.add('recognition.spi-device-selector.unresolved');
                        break;
                    }
                    case 'servo-attach':
                        if (!receiver) { gaps.add('recognition.receiver.unresolved'); break; }
                        emit(pin?.id, 'servo-signal', { owner: `servo:${receiver}` });
                        if (api.timer) emit(findResource(api.timer, 'timer')?.id, 'servo-timing', {
                            exclusive: true, owner: `implementation:${api.definitionFile}`,
                        });
                        else gaps.add('recognition.timer-allocation.unresolved');
                        effect('interrupt-sensitive');
                        break;
                    case 'interrupt-blocking': effect('interrupt-blocking'); break;
                    case 'tone':
                        emit(pin?.id, 'tone-output');
                        emit(input.mappings?.tone, 'tone-timing', { exclusive: true });
                        effect('interrupt-sensitive');
                        break;
                }
                continue;
            }
            if (primitives.length > 1) { gaps.add('recognition.api-evidence.ambiguous'); continue; }
            const summaries = apiEvidence.filter(api => api.callee === call.callee
                && arguments_[api.receiverArgument] === api.receiver
                && body.unit.dependencies.some(file => samePath(file, api.headerFile))
                && body.unit.referencedSymbols.filter(symbol => symbolName(symbol) === call.callee).length === 1
                && body.unit.referencedSymbols.some(symbol => symbolName(symbol) === call.callee
                    && api.definedSymbols.includes(symbol)));
            if (summaries.length === 1) {
                const api = summaries[0], addressToken = arguments_[api.addressArgument];
                const receiverName = api.receiver.replace(/^&/, '');
                if (body.parameters.includes(receiverName) || body.statements.some(item =>
                    new RegExp(`^(?:static )?[\\w:]+ ${receiverName}(?:;| = )`).test(item.text))) {
                    gaps.add('recognition.receiver.shadowed'); continue;
                }
                const commit = body.statements.findIndex((item, candidateIndex) => {
                    const next = parseCall(item);
                    return candidateIndex > index && mandatory.has(candidateIndex) && next?.callee === api.commitCallee
                        && argumentValue(next.arguments[api.receiverArgument] ?? '', parameters, body) === api.receiver;
                });
                if (commit < 0 || body.statements.slice(index + 1, commit).some(item => {
                    const between = parseCall(item);
                    return between && (!api.intermediateCallees.includes(between.callee)
                        || argumentValue(between.arguments[api.receiverArgument] ?? '', parameters, body) !== api.receiver);
                })) {
                    gaps.add('recognition.transaction.unresolved'); continue;
                }
                if (!addressToken || !/^\d+$/.test(addressToken) || Number(addressToken) > 127) {
                    gaps.add('recognition.address.unresolved'); continue;
                }
                const resources = input.graph.resources.filter(resource =>
                    resource.id === api.resourceAlias || resource.aliases?.includes(api.resourceAlias));
                if (resources.length !== 1 || resources[0].type !== 'i2c-controller'
                    || resources[0].sharing !== 'address') { gaps.add('recognition.bus.unresolved'); continue; }
                if (body.unit.kind === 'library' && (!body.unit.libraryRoot
                    || !normalize(body.unit.file).startsWith(`${normalize(body.unit.libraryRoot).replace(/\/$/, '')}/`))) {
                    gaps.add('recognition.library-selection.unresolved'); continue;
                }
                const resource = resources[0].id;
                const key = JSON.stringify([reference, body.unit.file, resource, addressToken]);
                if (seen.has(key)) continue;
                seen.add(key);
                const claim: ResourceClaim = {
                    id: `compiler-observation:${claims.length}`, reference,
                    owner: JSON.stringify([body.unit.libraryRoot ?? body.unit.file, resource, addressToken]),
                    resource, role: 'i2c-device', discriminator: String(Number(addressToken)), segment: resource,
                };
                claims.push(claim);
                traces.push({
                    blockId: reference, claimId: claim.id, origin: 'compiler-observation',
                    implementation: { file: body.unit.file, libraryRoot: body.unit.libraryRoot ?? '', version: body.unit.libraryVersion },
                    steps: nextSteps, apiEvidence: api.sourceEvidence,
                });
                continue;
            }
            if (summaries.length > 1) { gaps.add('recognition.api-evidence.ambiguous'); continue; }
            const targets = functions.filter(target => target.name === call.callee
                && target.parameters.length === call.arguments.length
                && target.unit.kind === 'library'
                && body.unit.referencedSymbols.filter(symbol => symbolName(symbol) === call.callee).length === 1
                && body.unit.referencedSymbols.some(symbol => symbolName(symbol) === call.callee
                    && target.unit.definedSymbols.includes(symbol)));
            if (targets.length !== 1) { gaps.add('recognition.call.unresolved'); continue; }
            if (arguments_.some(value => value === undefined)) { gaps.add('recognition.argument.unresolved'); continue; }
            walk(targets[0], arguments_ as string[], reference, nextSteps, depth + 1);
        }
    };
    for (const body of roots) walk(body, [], '', [], 0);
    // Production generators can emit pinMode(OUTPUT) in setup for the same
    // block's later PWM operation. That initialization is not a second GPIO
    // consumer. Coalesce only a proven same-block fixed output route; do not
    // merge other blocks, input modes, guessed routes or unrelated owners.
    const initializationOnly = new Set(claims.filter(claim => claim.role === 'digital-output'
        && traces.some(trace => trace.claimId === claim.id && trace.operation === 'pin-mode')
        && claims.some(output => output.reference === claim.reference && output.role === 'hardware-pwm'
            && input.graph.routes.some(route => route.resource === output.resource
                && route.mode === 'fixed' && route.signal === 'output' && route.pins[0] === claim.resource)))
        .map(claim => claim.id));
    for (let i = claims.length - 1; i >= 0; i--) if (initializationOnly.has(claims[i].id)) claims.splice(i, 1);
    for (let i = traces.length - 1; i >= 0; i--) if (initializationOnly.has(traces[i].claimId)) traces.splice(i, 1);
    if (!claims.length && !timing.length) return unknown('recognition.no-proven-usage');
    // Deliberately incomplete: recognizing one API never proves whole-project coverage.
    const analysis = analyzeHardwareResources(input.graph, claims, 1);
    return structuredClone({ status: 'Partial' as const, claims, traces, timing, gaps: [...gaps].sort(), analysis });
}
