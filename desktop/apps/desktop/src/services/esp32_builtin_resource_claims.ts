import { analyzeDeclaredHardware } from './resource_claim_binding';
import { compatLiteralField } from './blockly_compat_analysis';
import type { ResourceBlock, ResourceCatalogEntry } from './resource_claim_binding';
import type { ResourceClaimTemplate, ResourceOperand } from './resource_contract';
import type { ResourceClaim } from './hardware_resource_graph';
import { analyzeHardwareResources } from './hardware_resource_graph';
import { resolveEsp32FamilyResourceModel, type Esp32ResolvedIdentity, type Esp32SerialDefault } from './esp32_resource_family';

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
function serialSetupBaud(block: ResourceBlock) {
  const inputName = block.type === 'serial_begin' && block.getInputTargetBlock('CONTENT') ? 'CONTENT' : 'BAUD';
  return constantInput(block, inputName) ?? (block.getInputTargetBlock(inputName) ? undefined : '115200');
}

/** First-party ESP32 adapter. It only consumes the already resolved identity;
 * GPIO-matrix allocation and LEDC channel allocation remain explicit gaps. */
export function analyzeEsp32WorkspaceResources(identity: Esp32ResolvedIdentity, workspace: { getAllBlocks(ordered: boolean): ResourceBlock[] }, catalog: ResourceCatalogEntry[] = []) {
  // Model selection is identity-driven and happens before this generic
  // adapter.  Do not add a board-name or per-board analyzer branch here.
  const model = resolveEsp32FamilyResourceModel(identity);
  if (model.status !== 'ready') return { status: model.status, reason: model.reason };
  const modelWithClaims = model as typeof model & { adc?: Record<string, string> };
  const blocks = workspace.getAllBlocks(false);
  const claims: ResourceClaim[] = [];
  const gaps: { block?: string; code: string }[] = [];
  const aliases = new Map(model.resource_graph.resources.flatMap(resource => [[resource.id, resource.id], ...(resource.aliases ?? []).map(alias => [alias, resource.id])] as [string, string][]));
  const pure = new Set(['math_number', 'text', 'logic_boolean', 'board_pin_selector', 'serial_baudrate_selector', 'io_level', 'controls_global_defs_custom', 'controls_setup_custom', 'controls_loop_custom', 'macro_define_custom', 'code_include_custom', 'code_comment_custom']);
  const adapted = (block: ResourceBlock, gpio?: string): ResourceBlock => ({
    id: block.id, type: block.type, getFieldValue: name => block.getFieldValue(name),
    getInputTargetBlock: name => name === 'PIN' && gpio ? { id: `${block.id}:pin`, type: 'text', getFieldValue: () => gpio, getInputTargetBlock: () => null } : block.getInputTargetBlock(name),
  });
  const bind = (block: ResourceBlock, templates: ResourceClaimTemplate[], gpio?: string) => {
    const entry: ResourceCatalogEntry = { type: block.type, library_id: 'ck.builtin', metadata_source: 'v2', fields: ['MODE', 'PORT'].map(name => ({ name })), inputs: ['PIN', 'VALUE', 'BAUD', 'RX', 'TX'].map(name => ({ name })), hardware: { claims: { version: 1, coverage: 'full', templates } } };
    const result = analyzeDeclaredHardware(model, [entry], [adapted(block, gpio)]);
    gaps.push(...result.gaps); claims.push(...result.claims.map((claim, index) => ({ ...claim, id: `project:${claims.length + index}` })));
  };
  const serialPort = (block: ResourceBlock) => String(block.getFieldValue('PORT') || 'Serial');
  // Serial defaults are part of the selected model.  This keeps the claim
  // adapter independent of classic ESP32/C3 pin maps and USB-vs-UART policy.
  const serialDefaults: Record<string, Esp32SerialDefault> = model.metadata?.serialDefaults ?? model.serialDefaults ?? {};
  for (const block of blocks) {
    if (pure.has(block.type) || compatLiteralField(block)) continue;
    const pin = constantInput(block, 'PIN');
    const gpio = pin ? aliases.get(pin) : undefined;
    const pinNumber = gpio?.startsWith('gpio.') ? Number(gpio.slice(5)) : undefined;
    if (['write_digital', 'io_digital_write', 'io_digital_read', 'set_pin_mode'].includes(block.type)) {
      let role = block.type === 'io_digital_read' ? 'digital-input' : 'digital-output';
      if (block.type === 'set_pin_mode') role = block.getFieldValue('MODE') === 'OUTPUT' ? 'digital-output' : 'digital-input';
      if (!gpio || pinNumber === undefined) { gaps.push({ block: block.id, code: 'unresolved-gpio' }); continue; }
      const resource = model.resource_graph.resources.find(r => r.id === gpio);
      if (role === 'digital-output' && resource?.capabilities?.includes('input-only')) { gaps.push({ block: block.id, code: 'input-only-gpio' }); continue; }
      bind(block, [{ id: 'gpio', resource: { kind: 'input', name: 'PIN', valueType: 'id' }, role, owner: fixed(`${role}.${pinNumber}`) }], gpio);
      continue;
    }
    if (block.type === 'io_analog_read') {
      const channel = pin ? modelWithClaims.adc?.[pin] : undefined;
      if (!channel) { gaps.push({ block: block.id, code: 'unsupported-analog-pin' }); continue; }
      bind(block, [{ id: 'adc', resource: fixed(channel), role: 'analog-read', owner: fixed(channel) }], gpio);
      continue;
    }
    if (block.type === 'io_analog_write' || block.type === 'io_soft_pwm_write' || block.type === 'io_soft_pwm_stop') {
      if (!gpio || pinNumber === undefined) { gaps.push({ block: block.id, code: 'unresolved-pwm-pin' }); continue; }
      const resource = model.resource_graph.resources.find(r => r.id === gpio);
      if (resource?.capabilities?.includes('input-only')) { gaps.push({ block: block.id, code: 'input-only-pwm-pin' }); continue; }
      const duty = block.type === 'io_soft_pwm_stop' ? '0' : constantInput(block, 'VALUE');
      if (duty === undefined) gaps.push({ block: block.id, code: 'dynamic-pwm-duty' });
      bind(block, [
        { id: 'gpio', resource: { kind: 'input', name: 'PIN', valueType: 'id' }, role: 'pwm-output-pin', owner: fixed(`pwm.pin.${pinNumber}`) },
        { id: 'ledc', resource: fixed('ledc'), role: 'hardware-pwm', owner: fixed(`pwm.channel.${block.id}`) },
      ], gpio);
      gaps.push({ block: block.id, code: 'dynamic-ledc-channel-unresolved' });
      continue;
    }
    if (serialConsumers.has(block.type) || block.type === 'serial_setup' || block.type === 'serial_begin' || block.type === 'serial_setup_with_pins') {
      const port = block.type === 'serial_setup_with_pins' ? serialPort(block) : 'Serial';
      const chosen = serialDefaults[port];
      const baud = serialSetupBaud(block);
      if (!chosen) { gaps.push({ block: block.id, code: 'unavailable-uart-port' }); continue; }
      const rx = constantInput(block, 'RX'); const tx = constantInput(block, 'TX');
      const config: Record<string, ResourceOperand> = baud && /^\d+$/.test(baud) ? { baud: { kind: 'fixed', valueType: 'integer', value: Number(baud) } } : {};
      if (!Object.keys(config).length) gaps.push({ block: block.id, code: 'dynamic-uart-baud' });
      const transport = chosen.transport ?? 'uart';
      const signals: Record<string, ResourceOperand> = {};
      if (transport === 'uart') {
        // A model may intentionally omit a UART default (for example a
        // GPIO-matrix UART whose Core requires explicit pins).  Explicit
        // block inputs still bind safely through the selected graph.
        const resolvedRx = rx ? aliases.get(rx) : chosen.rx;
        const resolvedTx = tx ? aliases.get(tx) : chosen.tx;
        if (resolvedRx) signals.rx = fixed(resolvedRx);
        if (resolvedTx) signals.tx = fixed(resolvedTx);
      } else if (rx || tx) {
        // USB Serial/JTAG has fixed D+/D- pads and does not accept UART pin
        // routing.  Keep this as an explicit analysis gap instead of silently
        // treating user-entered RX/TX as valid machine data.
        gaps.push({ block: block.id, code: 'serial-transport-does-not-accept-pins' });
      }
      bind(block, [{ id: 'serial', resource: fixed(chosen.resource), role: transport === 'uart' ? 'hardware-uart' : 'hardware-serial', owner: fixed(port), configuration: config, ...(Object.keys(signals).length ? { signals } : {}) }]);
      continue;
    }
    if (catalog.some(entry => entry.type === block.type)) {
      const declared = analyzeDeclaredHardware(model, catalog, [block]);
      gaps.push(...declared.gaps);
      for (const claim of declared.claims) claims.push({ ...claim, id: `project:${claims.length}` });
    } else gaps.push({ block: block.id, code: 'builtin-claim-not-covered' });
  }
  return { status: 'ready' as const, model, claims, gaps, report: analyzeHardwareResources(model.resource_graph, claims, gaps.length), coverage: { declarationCoverage: gaps.length ? 'partial' as const : 'full' as const, analysisCoverage: 'partial' as const, hardwareEvidence: 'source-verified-not-hardware-tested' as const, projectCoverage: 'partial' as const } };
}
