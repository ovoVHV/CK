import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const boards = ['arduino:avr:uno', 'esp32:esp32:esp32s3'];
const board = boards[0];
const architectures = ['avr', 'esp32'];
export const n = (name, value, description) => ({ name, value, description });
export const fixed = (value, valueType = 'id') => ({ kind: 'fixed', valueType, value });
export const gpio = (name, role, description) => ({
  resource: { kind: 'gpio', id: name.toLowerCase(), description, source: { kind: 'input', name },
    access: role === 'digital-input' ? 'read' : role === 'digital-output' ? 'write' : 'read-write',
    sharing: 'exclusive', capabilities: [role === 'servo-signal' ? 'digital-output' : role === 'gpio' ? 'digital-input' : role] },
  claim: { id: name.toLowerCase(), resource: { kind: 'input', name, valueType: 'id' }, role, exclusive: true },
});
const numeric = value => ({ type: 'math_number', fields: { NUM: value } });
const attach = v => typeof v === 'number' ? { shadow: numeric(v) } : { block: v };
const inputs = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, attach(v)]));
export const block = (type, id, args = {}, fields) => ({
  type, id, ...(Object.keys(args).length ? { inputs: inputs(args) } : {}), ...(fields ? { fields } : {}),
});
export function chain(...items) {
  for (let i = 0; i < items.length - 1; i++) items[i].next = { block: items[i + 1] };
  return items[0];
}
export const serial = id => block('serial_setup', id, { BAUD: 9600 });
export const print = (id, value) => block('serial_print', id, { MSG: value }, { NEWLINE: 'TRUE' });
export const when = (id, condition, body) => block('controls_if', id, { IF0: condition, DO0: body });
export const math = (id, a, b) => block('math_arithmetic', id, { A: a, B: b }, { OP: 'ADD' });
export const wait = (id, ms) => block('controls_delay', id, { DELAY_TIME: ms });
export const error = (code, message, cause, recovery) => ({ code, severity: 'error', message, cause, recovery });
export const slots = (ns, prefix) => {
  const arg = n('CHANNEL', 1, '编译期实例编号：1 或 2。初始化和后续操作填同一编号。');
  const code = `${prefix}_CHANNEL`;
  const err = error(code, '实例编号须为 1 或 2 的整数常量。', '该库只预留两个独立实例。', '将通道号改为 1 或 2 后重新编译。');
  return {
    arg, err, code,
    call: (fn, args = '') => `${ns}::${fn}<({{value:CHANNEL}})>(${args})`,
    check: `static_assert(({{value:CHANNEL}}) == 1 || ({{value:CHANNEL}}) == 2, "${code}: use channel 1 or 2");\n`,
  };
};

export function build(d, root) {
  const dir = path.join(root, 'packages', d.id);
  const put = (dest, bytes) => {
    const out = path.join(dir, dest);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bytes);
  };
  const json = (dest, obj) => put(dest, JSON.stringify(obj, null, 2) + '\n');
  const deps = d.drivers.map(x => ({
    kind: 'arduino-library', id: x.name, version: x.version, headers: [x.header], license: x.license,
    reason: `随包内置于 libraries/${x.name}/。`,
  }));
  if (d.adapter) deps.unshift({
    kind: 'arduino-library', id: d.adapter.name, version: d.version, headers: [d.adapter.header],
    license: 'Apache-2.0', reason: `随包内置于 libraries/${d.adapter.name}/，提供图形积木所需的状态封装。`,
  });
  if (d.coreDeps) deps.push(...d.coreDeps);
  const include = `#include <${d.header}>`;
  const docEntries = [], definitions = [], rules = [], entries = [];
  for (const b of d.blocks) {
    const type = `${d.id}_${b.id}`;
    const args = b.args ?? [];
    const out = b.output;
    const shape = out ? 'expression' : 'statement';
    const code = b.code + (out ? '' : '\n');
    definitions.push({
      type, message0: b.label,
      ...(args.length ? { args0: args.map(p => ({ type: 'input_value', name: p.name, check: 'Number' })), inputsInline: true } : {}),
      ...(out ? { output: out } : { previousStatement: null, nextStatement: null }),
      colour: d.color, tooltip: b.description, helpUrl: '',
    });
    rules.push({ type, kind: shape, includes: { [d.header.replace('.', '_')]: include }, template: code });
    const defaults = inputs(Object.fromEntries(args.map(p => [p.name, p.value])));
    entries.push({ kind: 'block', type, ...(args.length ? { inputs: defaults } : {}) });
    docEntries.push({
      type, display_name: b.label, description: b.description, category: d.name, kind: out ? 'value' : 'statement',
      keywords: [d.name, d.id, ...(d.keywords ?? [])],
      semantics: { purpose: b.description, behavior: b.description, concepts: [d.name], side_effects: b.effects ?? [] },
      fields: [], inputs: args.map(p => ({ name: p.name, kind: 'value', description: p.description,
        check: 'Number', required: true, default: p.value })),
      output: out ? { connection: 'value', types: [out], description: b.description, ...(b.unit ? { unit: b.unit } : {}) }
        : { connection: 'none', types: [] },
      dependencies: deps,
      hardware: {
        resources: (b.hardware ?? []).map(h => h.resource),
        claims: { version: 1, coverage: 'partial', templates: (b.hardware ?? []).flatMap(h => h.claim ? [h.claim] : []) },
        boards, architectures, notes: b.hardwareNotes ?? [d.resourceNote],
      },
      generation: {
        language: 'arduino-cpp', shape, deterministic: true,
        emissions: [{ section: 'include', description: '引入已内置的头文件', template: include },
          { section: shape, description: b.description, template: code }],
      },
      constraints: [{ id: 'usage', severity: 'info', description: d.constraints, message: d.constraints }],
      examples: [{ id: 'demo', title: '随包示例', description: d.description, expected_behavior: d.observation,
        project: 'examples/demo.ck', boards: [board] }],
      errors: b.error ? [b.error] : [],
    });
  }

  json('library.json', { id: d.id, name: d.name, description: d.description, version: d.version,
    author: 'CK Library Batch', architectures, license: 'Apache-2.0', includes: [d.header] });
  json('ck-blocks.json', { schema_version: 2, id: d.id, display_name: d.name, description: d.description,
    license: { spdx_id: 'Apache-2.0', file: 'LICENSE.txt' }, compatibility: { architectures, boards },
    entrypoints: { blocks: 'blocks/blocks.json', generator: 'blocks/ck-generator.json', toolbox: 'blocks/toolbox.json' },
    blocks: docEntries,
  });
  json('blocks/blocks.json', definitions);
  json('blocks/ck-generator.json', { schema: 'ck-generator', version: 1, rules });
  json('blocks/toolbox.json', { kind: 'category', name: d.name, colour: d.color, contents: entries });

  const wrap = (type, id, x, body) => ({ ...block(type, id, { DO: body }), x, y: 38 });
  const graph = { blocks: { languageVersion: 0, blocks: [
    wrap('controls_setup_custom', `${d.id}-setup`, 36, d.demo.setup),
    wrap('controls_loop_custom', `${d.id}-loop`, 520, d.demo.loop),
  ] } };
  const project = { format: 'ck-project', schema_version: 1, migration_version: 1, name: `${d.name} 演示`,
    board, board_package_id: board, options: '{}' };
  json('examples/demo.ck', { ...project, xml: JSON.stringify(graph) });
  json('examples/demo-s3.ck', { ...project, board: boards[1], board_package_id: boards[1], xml: JSON.stringify(graph) });
  let mutated = 0;
  function change(o) {
    if (!o || typeof o !== 'object') return;
    if (o.id === d.negative.blockId) {
      const field = o.inputs[d.negative.input].shadow.fields;
      assert.equal(field.NUM, d.negative.repair);
      field.NUM = d.negative.invalid;
      mutated++;
    }
    for (const v of Object.values(o)) change(v);
  }
  change(graph);
  assert.equal(mutated, 1);
  json('examples/invalid.ck', { ...project, xml: JSON.stringify(graph) });
  json('examples/invalid-s3.ck', { ...project, board: boards[1], board_package_id: boards[1], xml: JSON.stringify(graph) });
  json('examples/expected.json', { board, boards, positive: 'demo.ck', negative: 'invalid.ck', ...d.negative });

  const licenses = fs.readFileSync(new URL('../../LICENSE', import.meta.url));
  put('LICENSE.txt', licenses);
  put('NOTICE.txt', `CK Library Batch: ${d.name}\nThe CK blocks and original adapters are Apache-2.0.\nSee THIRD-PARTY.md for upstream code and its separate licenses.\n`);
  const sources = [];
  for (const driver of d.drivers) {
    sources.push(`- ${driver.name} ${driver.version} (${driver.license})：${driver.source}\n  - 下载：${driver.url}\n  - 下载 SHA-256：\`${driver.sha256}\`\n  - 原许可证：\`libraries/${driver.name}/${driver.licenseFile}\``);
  }
  if (d.adapter) {
    const a = d.adapter;
    put(`libraries/${a.name}/library.properties`, `name=${a.name}\nversion=${d.version}\nauthor=CK Library Batch\nmaintainer=CK Library Batch\nsentence=Adapter for CK ${d.id} blocks.\nparagraph=Package-local state and instance management.\ncategory=Other\narchitectures=avr,esp32\nincludes=${a.header}\n${d.depends ? `depends=${d.depends}\n` : ''}`);
    put(`libraries/${a.name}/LICENSE.txt`, licenses);
    const adapterPath = new URL(`./drivers/${a.name}/`, import.meta.url);
    for (const f of fs.readdirSync(adapterPath)) put(`libraries/${a.name}/src/${f}`, fs.readFileSync(new URL(f, adapterPath)));
  }
  put('THIRD-PARTY.md', `# 上游驱动\n\n${sources.join('\n')}\n${d.coreNote ? `\n${d.coreNote}\n` : ''}`);
  put('README.md', `# ${d.name} ${d.version}\n\n${d.description}\n\n## 导入和接线\n\n在 CK 选择示例板卡，再通过「库管理器 → 导入」选择本库 ZIP。导入后可在工具箱打开「${d.name}」分类。解压 ZIP 后打开 \`examples/demo.ck\`。\n\n${d.wiring}\n\n## 正常示例\n\n${d.observation}\n\n${d.constraints}\n\n## 积木\n\n${d.blocks.map(b => `- **${b.label.replace(/ %\d/g, '')}**：${b.description}`).join('\n')}\n\n## 诊断示例\n\n打开 \`examples/invalid.ck\` 并编译。${d.repairText} 预期实例：\`${d.negative.blockId}\`；诊断：\`${d.negative.errorCode}\`。详细机读预期见 \`examples/expected.json\`。\n\n## 支持范围\n\nUno 使用 demo.ck / invalid.ck；ESP32-S3（Arduino Core 3.x）使用 demo-s3.ck / invalid-s3.ck。其他板卡未验收。编译不代表接线或硬件实测。驱动来源与原许可证见 [THIRD-PARTY.md](THIRD-PARTY.md)。\n`);
}
