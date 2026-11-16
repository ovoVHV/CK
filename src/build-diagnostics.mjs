// Human-readable fields from the structured result; never invent zero when
// the official frontend did not provide a process count.
import {formatResourceEvidence} from './build-resource-evidence.mjs';
export function formatBuildDiagnostics(r) {
 const count=k=>Number.isFinite(r.counts?.[k])?String(r.counts[k]):'未统计';
 const seconds=k=>Number.isFinite(r.phases?.[k])?(r.phases[k]/1000).toFixed(3)+'s':'未执行/未统计';
 const lines=[`[V9] 发现图：${r.graphReuse?.hit?'复用':'重新发现'}；原因：${r.graphReuse?.reason??'未记录'}`];
 if(r.executionJobs)lines.push(`[V9] 实际并行任务上限：${r.executionJobs}`);
 if(r.propertyExpansion)lines.push(`[V9] 板卡参数：${r.propertyExpansion.native?'CK 直接展开':'官方 CLI 展开'}；Core=${r.propertyExpansion.coreVersion??'未记录'}；原因：${r.propertyExpansion.reason}`);
 if(r.batchTimings?.some(t=>t.executor==='direct'))lines.push('[V9] 原生任务由会话调度器直接执行；取消仍终止所属进程树。');
 if(r.sourceEligibility?.eligible===false)lines.push(`[V9] 前端回退原因：${r.sourceEligibility.reason}`);
 if(r.officialReason)lines.push(`[V9] 官方前端：${r.officialReason}`);
 if(r.frontend)lines.push(`[V9] 原型处理：${r.frontend.replayed?'重放':'重新生成'}；原因：${r.frontend.reason}`);
 if(r.prototypePreprocessReused)lines.push('[V9] 原型预处理：复用本次发现中已验证的 GCC 结果；仍执行 CTags。');
 lines.push(`[V9] 实际任务：Discovery GCC=${count('DiscoveryGCC')}，Prototype GCC=${count('PrototypeGCC')}，Compile GCC=${count('CompileGCC')}，Link=${count('Linker')}，Image=${count('ImageGenerator')}`);
 if(r.counts?.DiscoveryCompileGCC)lines.push(`[V9] 编译总数包含发现期间编译=${count('DiscoveryCompileGCC')}；其中直接使用对象=${count('ObjectProducedDuringDiscovery')}；调度阶段编译=${count('SchedulerCompileGCC')}。这些是本次新编对象，不是缓存恢复。`);
 lines.push(`[V9] 对象沿用=${count('ObjectRetained')}，对象恢复=${count('ObjectRestored')}；相同源码快速路径=${r.noOpFastPath?.hit===true?'命中':'未命中'}`);
 lines.push(`[Timing] V9 资产校验：前=${seconds('inputValidationMs')}，后=${seconds('postValidationMs')}；发现及并行编译=${seconds('discoveryMs')}；官方前端=${seconds('officialFrontendMs')}`);
 lines.push(`[Timing] V9 原型=${seconds('prototypeMs')}；任务执行（含收据观察）=${seconds('executeMs')}；收据观察=${seconds('ruleObservationMs')}`);
 if(r.coldDiscovery)lines.push('[Timing] V9 库选择完成='+((r.coldDiscovery.selectionReadyMs??0)/1000).toFixed(3)+'s（从发现开始计时，已包含库编译；与 Core 编译重叠）');
 if(r.coldPipeline)lines.push('[V9] Sketch 提前编译='+count('PipelinedSketchGCC')+'；开始='+ (r.coldPipeline.sketchStartedMs/1000).toFixed(3)+'s，结束='+(r.coldPipeline.sketchFinishedMs/1000).toFixed(3)+'s（相对发现开始；已计入并行阶段）');
 if(Number.isFinite(r.phases?.prepareMs))lines.push('[Timing] V9 属性='+seconds('propertiesMs')+'；准备='+seconds('prepareMs')+'；索引='+seconds('indexMs')+'；构图='+seconds('graphMs')+'；NoOp 授权观察='+seconds('noOpAuthorityCaptureMs'));
 for(const [name,proof]of [['前',r.assetProof],['后',r.postAssetProof]])if(proof?.metrics){const m=proof.metrics;lines.push('[Timing] V9 资产'+name+'校验细分：枚举墙钟='+(m.enumerationMs/1000).toFixed(3)+'s；打开线程累计='+(m.openSumMs/1000).toFixed(3)+'s；读取线程累计='+(m.readSumMs/1000).toFixed(3)+'s；哈希线程累计='+(m.hashSumMs/1000).toFixed(3)+'s；打开线程='+(proof.openWorkers??0)+'，读取线程='+(proof.workers??'未统计')+'（累计值有并发重叠，不能相加当总耗时）');}
 if(r.batchTimings?.length){
  const totals=new Map();for(const t of r.batchTimings){const key=t.kinds.join('+');totals.set(key,(totals.get(key)??0)+t.elapsedMs);}
  lines.push('[Timing] V9 执行阶段墙钟：'+[...totals].map(([k,v])=>`${k}=${(v/1000).toFixed(3)}s`).join('；'));
 }
 lines.push(...formatResourceEvidence(r.resources));
 return lines.join('\n')+'\n';
}
