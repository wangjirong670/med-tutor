import type { DraftInspection, Source } from '../../core/material/model.js';
import { inspectGeneration, type OutputMode } from '../../core/material/generation.js';

export type CandidateRecord = { kind: 'unaccepted-candidate'; requestId: string; adapterVersion: string; inspection: DraftInspection; note: string };
export function inspectResponse(raw: string, sources: Source[], options: { finishReason?: string; outputMode?: OutputMode } = {}): DraftInspection {
  return inspectGeneration(raw, sources, options);
}
export function candidateRecord(requestId: string, adapterVersion: string, inspection: DraftInspection): CandidateRecord {
  return { kind: 'unaccepted-candidate', requestId, adapterVersion, inspection, note: '仅供离线核对；引用定位成立不代表整句有依据；不进入有效学习单，不支持自动部分接收。' };
}
export function renderCandidate(record: CandidateRecord): string {
  const i = record.inspection;
  const lines = ['# 模型候选稿 · 核对视图', '', '**此视图不是有效学习单。正式接收状态以会话事件为准；这里不会接收条目或覆盖旧稿。**', '', `请求：${record.requestId}；适配提示：${record.adapterVersion}`, `定位检查：${i.ok ? '通过；语义仍未审阅' : `未通过（${i.issues.length}项问题）`}；semanticStatus=${i.semanticStatus}`, '', record.note, '', '## 定位问题', ''];
  for (const issue of i.issues) lines.push(`- ${issue.ownerId ?? ''} ${issue.path} **${issue.code}**：${issue.message}`, ...(issue.candidates?.map(c => `  - 候选原文位置 ${c.start}-${c.end}；${c.method}；片段 ${c.fragmentIds.join(', ') || '跨片段'}`) ?? []));
  for (const c of i.content?.claims ?? []) {
    const issues = i.issues.filter(e => e.ownerId === c.id);
    lines.push('', `## [${c.id}] 候选${c.origin === 'ai' ? ' AI补充（待核）' : issues.length ? '材料条目（定位未通过）' : '材料条目（定位通过，整句支持未核）'}`, '', c.text);
    if (c.citationNote !== undefined) lines.push('', `模型注释（待审，不是教材依据）：${c.citationNote}`);
    for (const r of i.references.filter(r => r.ownerId === c.id)) {
      lines.push('', `- ${r.path}：${r.ok ? r.resolved?.resolution?.method ?? 'exact' : r.issue?.code}；${r.sourceId}@${r.revision}`, `  - 模型原 quote：${r.quote}`);
      if (r.resolved) lines.push(`  - 实际原文 ${r.resolved.start}-${r.resolved.end}：${r.resolved.resolution?.originalQuote ?? r.resolved.quote}`);
    }
  }
  i.content?.conflicts.forEach((c, n) => {
    lines.push('', `## 候选冲突 ${n + 1}（是否互斥未核）`, '', c.text);
    for (const r of i.references.filter(r => r.ownerId === `conflict_${n + 1}`)) {
      lines.push('', `- ${r.path}：${r.ok ? r.resolved?.resolution?.method ?? 'exact' : r.issue?.code}；${r.sourceId}@${r.revision}`, `  - 模型原 quote：${r.quote}`);
      if (r.resolved) lines.push(`  - 实际原文 ${r.resolved.start}-${r.resolved.end}：${r.resolved.resolution?.originalQuote ?? r.resolved.quote}`);
    }
  });
  if (i.modelMetadata) lines.push('', '## 旧响应回写的元数据（仅保留供诊断，不作权威属性）', '', '```json', JSON.stringify(i.modelMetadata, null, 2), '```');
  if (i.stages) lines.splice(6, 0, `阶段：${JSON.stringify(i.stages)}；finish_reason=${i.finishReason ?? 'unknown'}`);
  return lines.join('\n') + '\n';
}
