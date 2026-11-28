import { resolveAvrResourceModel } from './avr_resource_model';
import type { ResolvedAvrResourceIdentity } from './avr_resource_model';
import { analyzeDeclaredHardware } from './resource_claim_binding';
import type { ResourceBlock, ResourceCatalogEntry } from './resource_claim_binding';
import { compatLiteralField } from './blockly_compat_analysis';
import type { ResourceClaimTemplate, ResourceOperand } from './resource_contract';
import { analyzeHardwareResources } from './hardware_resource_graph';
import type { ResourceClaim } from './hardware_resource_graph';

const fixed = (value: string): ResourceOperand => ({ kind: 'fixed', valueType: 'id', value });
function constantInput(block: ResourceBlock, name: string): string | undefined {
  const input = block.getInputTargetBlock(name);
  let value: unknown;
  if (!input) value = block.getFieldValue(name);
  else if (input.type === 'board_pin_selector') value = input.getFieldValue('PIN');
  else if (input.type === 'math_number') value = input.getFieldValue('NUM');
  else if (input.type === 'text') value = input.getFieldValue('TEXT');
  else if (input.type === 'serial_baudrate_selector') value = input.getFieldValue('BAUD');
  else return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length ? value : undefined;
}
const serialConsumers = new Set(['serial_print', 'serial_println', 'serial_available', 'serial_read_string', 'serial_read_string_until', 'serial_read_byte', 'serial_flush_input', 'serial_write_raw', 'serial_print_number', 'serial_read_if_available']);
function serialSetupBaud(block: ResourceBlock): string | undefined {
  const inputName = block.type === 'serial_begin' && block.getInputTargetBlock('CONTENT') ? 'CONTENT' : 'BAUD';
  return constantInput(block, inputName) ?? (block.getInputTargetBlock(inputName) ? undefined : '9600');
}
/** Explicit first-party adapters, following current generator implementations, not block names. */
export function analyzeAvrWorkspaceResources(identity: ResolvedAvrResourceIdentity, workspace: { getAllBlocks(ordered: boolean): ResourceBlock[] }, catalog: ResourceCatalogEntry[] = []) {
  const model = resolveAvrResourceModel(identity);
  if (model.status !== 'ready') return { status: model.status, reason: model.reason };
  const claims: ResourceClaim[] = [];
  const gaps: { block?: string; code: string }[] = [];
  const blocks = workspace.getAllBlocks(false);
  const selectedSerialPort = (block: ResourceBlock): string => block.type === 'serial_setup_with_pins' ? String(block.getFieldValue('PORT') || 'Serial') : 'Serial';
  const serialSetups = blocks.filter(b => b.type === 'serial_setup' || b.type === 'serial_begin' || b.type === 'serial_setup_with_pins');
  // Generator has one Serial setup slot. Conflicting setup order is not two devices;
  // keep it unresolved rather than inventing simultaneous baud requirements.
  const effectiveBaud = (port: string) => {
    const baudValues = serialSetups.filter(b => selectedSerialPort(b) === port).map(serialSetupBaud);
    return !baudValues.length ? '115200' : baudValues.every(v => v !== undefined && v === baudValues[0]) ? baudValues[0] : undefined;
  };
  const pure = new Set(['math_number', 'text', 'logic_boolean', 'board_pin_selector', 'serial_baudrate_selector', 'io_level', 'controls_global_defs_custom', 'controls_setup_custom', 'controls_loop_custom', 'macro_define_custom', 'code_include_custom', 'code_comment_custom']);
  for (const block of blocks) {
    if (pure.has(block.type) || compatLiteralField(block)) continue;
    const pin = constantInput(block, 'PIN');
    const aliases = new Map(model.resource_graph.resources.filter(r => r.type === 'gpio').flatMap(r => [[r.id, r.id], ...(r.aliases ?? []).map(a => [a, r.id])]) as [string, string][]);
    const gpio = pin ? aliases.get(pin) : undefined;
    const pinNumber = gpio?.slice('gpio.'.length);
    let templates: ResourceClaimTemplate[] = [];
    let role: string | undefined;
    switch (serialConsumers.has(block.type) ? 'serial-consumer' : block.type) {
      case 'write_digital': case 'io_digital_write': role = 'digital-output'; break;
      case 'io_digital_read': role = 'digital-input'; break;
      case 'set_pin_mode': {
        const mode = block.getFieldValue('MODE');
        if (mode === 'OUTPUT') role = 'digital-output';
        else if (mode === 'INPUT' || mode === 'INPUT_PULLUP') role = 'digital-input';
        break;
      }
      case 'io_analog_write': case 'io_soft_pwm_write': case 'io_soft_pwm_stop': {
        const raw = block.type === 'io_soft_pwm_stop' ? '0' : constantInput(block, 'VALUE');
        const value = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
        if (value === undefined) gaps.push({ block: block.id, code: 'dynamic-pwm-duty' });
        const channel = pinNumber === undefined ? undefined : model.pwm[pinNumber];
        if (channel && value !== 0 && value !== 255) {
          templates = [{ id: 'pwm', resource: fixed(channel), role: 'hardware-pwm', owner: fixed(`pwm.${pinNumber}`) }];
        } else role = 'digital-output';
        break;
      }
      case 'io_analog_read': {
        const channel = pin === undefined ? undefined : model.adc[pin];
        if (channel) templates = [{ id: 'adc', resource: fixed(channel), role: 'analog-read', owner: fixed(channel) }];
        break;
      }
      case 'serial-consumer': case 'serial_setup': case 'serial_begin': case 'serial_setup_with_pins': {
        const port = selectedSerialPort(block);
        // Port selection exists only on the production setup block. Read/print/etc.
        // still generate Serial.*; AVR ignores setup RX/TX operands and uses fixed routes.
        const controller = model.resource_graph.resources.find(r => r.type === 'uart-controller' &&
          (r.aliases ?? []).includes(port));
        if (!controller || !['Serial', 'Serial1', 'Serial2'].includes(port)) {
          gaps.push({ block: block.id, code: 'unavailable-uart-port' }); continue;
        }
        // A connected dynamic expression is unresolved, not permission to use a fallback.
        const baud = effectiveBaud(port);
        if (baud && /^\d+$/.test(baud) && Number.isSafeInteger(Number(baud)) && Number(baud) > 0) templates = [{ id: 'serial', resource: fixed(controller.id), role: 'hardware-uart', owner: fixed(port), configuration: { baud: { kind: 'fixed', valueType: 'integer', value: Number(baud) } } }];
        break;
      }
      default: {
        // Libraries use the same declaration/binding boundary as built-ins.
        // Keep this after the built-in adapter so package metadata cannot override it.
        if (!catalog.some(entry => entry.type === block.type)) {
          gaps.push({ block: block.id, code: 'builtin-claim-not-covered' }); continue;
        }
        const declared = analyzeDeclaredHardware(model, catalog, [block]);
        gaps.push(...declared.gaps);
        for (const claim of declared.claims) claims.push({ ...claim, id: `project:${claims.length}` });
        continue;
      }
    }
    if (role && gpio) templates = [{ id: 'gpio', resource: { kind: 'input', name: 'PIN', valueType: 'id' }, role, owner: fixed(`${role}.${pinNumber}`) }];
    if (!templates.length) { gaps.push({ block: block.id, code: 'unresolved-builtin-claim' }); continue; }
    const adapted: ResourceBlock = {
      id: block.id, type: block.type,
      getFieldValue: name => block.getFieldValue(name),
      getInputTargetBlock: name => name === 'PIN' && gpio ? {
        id: `${block.id}:resolved-pin`, type: 'text', getFieldValue: () => gpio, getInputTargetBlock: () => null,
      } : block.getInputTargetBlock(name),
    };
    const result = analyzeDeclaredHardware(model, [{ type: block.type, library_id: 'ck.builtin', metadata_source: 'v2', fields: [], inputs: [{ name: 'PIN' }], hardware: { claims: { version: 1, coverage: 'full', templates } } }], [adapted]);
    gaps.push(...result.gaps);
    for (const claim of result.claims) claims.push({ ...claim, id: `project:${claims.length}` });
  }
  // wiring.c installs the Timer0 overflow timebase unconditionally. It is a consumer,
  // not a blanket reserved=true flag that would incorrectly reject ordinary Timer0 PWM.
  claims.push({ id: 'core:timebase', owner: 'arduino-core', reference: 'core:wiring.c', resource: 'TIMER0', role: 'core-timebase' });
  const report = analyzeHardwareResources(model.resource_graph, claims, gaps.length);
  return { status: 'ready' as const, model, claims, gaps, report, coverage: {
    declarationCoverage: gaps.length ? 'partial' as const : 'full' as const,
    analysisCoverage: report.gaps.length ? 'partial' as const : 'full' as const,
    hardwareEvidence: 'source-verified-not-hardware-tested' as const,
    projectCoverage: 'partial' as const,
  } };
}
