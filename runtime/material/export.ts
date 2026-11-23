import type { Citation, Draft, Source, State } from '../../core/material/model.js';
import { latestSources, claimChanges } from '../../core/material/model.js';
export const closing = '学习向输出：用于整理理解与复习，不构成诊疗建议；真实病人请走上级医师或院内流程。';
const sourceLabel = (s: Source) => s.kind === 'note' ? '你的笔记/口述（未核教材）' : s.kind === 'ocr' ? '转写自扫描/图片（识别待核，未核教材）' : '持有材料/讲义（未核教材）';
export function reference(c: Citation, sources: Source[]): string {
  const source = sources.find(s => s.id === c.sourceId && s.revision === c.revision)!;
  const original = c.resolution?.originalQuote ?? c.quote;
  const match = c.resolution?.method === 'layout-whitespace' ? `（排版空白匹配；模型原 quote：「${c.quote}」）` : '';
  return `${c.sourceId}@${c.revision} · ${source?.name ?? '?'} · ${source?.locator ?? '?'} · 字符${c.start ?? '?'}-${c.end ?? '?'}：「${original}」${match}`;
}
export function renderSources(state: State, allVersions = false): string {
  return (allVersions ? state.sources : latestSources(state.sources)).map(s => `### ${s.id}@${s.revision} · ${s.name} · ${s.locator}\n\n- 来源性质：${sourceLabel(s)}\n- 提取：${s.method}\n- 覆盖：${s.coverage}\n- 原件：${s.original}（sha256 ${s.originalSha256}）\n- 页图：${s.preview ?? '无；文本原件'}\n- 文字 sha256：${s.sha256}\n- 待核：${s.uncertainties.join('；')}\n\n\`\`\`text\n${s.text}\n\`\`\``).join('\n\n');
}
export function renderAudit(state: State, draft: Draft | undefined = state.drafts.at(-1)): string {
  if (!draft) return `尚无有效学习单。已导入${latestSources(state.sources).length}个切片。${state.pending ? `在途请求 ${state.pending}，用 abandon / retry 处理。` : ''}`;
  const lines = [`# ${draft.title.endsWith('学习钉子单') ? draft.title : draft.title + '学习钉子单'}`, `> 版本 ${draft.version} · 来源定位通过不等于语义或医学事实核对通过`, '', draft.status, '', '材料尚未与可翻的教材核对；本批没有教材证据升级。'];
  if (draft.rulesNote) lines.push('', `规则：${draft.rulesNote}；sha256 ${draft.rulesHash}`);
  for (const [section, title] of [['concept', '概念钉子'], ['backbone', '主干'], ['pitfall', '易错对照']] as const) {
    lines.push('', `## ${title}`, '');
    for (const c of draft.claims.filter(c => c.section === section)) {
      const label = c.origin === 'ai' ? '我补的，待你核对' : [...new Set(c.citations.map(r => state.sources.find(s => s.id === r.sourceId && s.revision === r.revision)).filter((s): s is Source => !!s).map(sourceLabel))].join(' / ');
      lines.push(`<a id="claim-${c.id}"></a>`, '', `- **[${c.id}] ${label}**：${c.text}`, ...c.citations.map(r => `  - 来源：${reference(r, state.sources)}`), '');
      if (c.citationNote !== undefined) lines.push(`模型注释（待审，不是教材依据）：${c.citationNote}`, '');
    }
  }
  lines.push('## 另一种说法 / 材料冲突', '');
  lines.push(...(draft.conflicts.length ? draft.conflicts.flatMap(c => [`- ${c.text}`, ...c.sides.map(r => `  - ${reference(r, state.sources)}`)]) : ['本版未列出冲突；这不代表全文没有冲突。']));
  lines.push('', '## 还不能当真的地方', '', ...draft.uncertainties.map(s => `- ${s}`));
  lines.push(...latestSources(state.sources).flatMap(s => s.uncertainties.map(u => `- ${s.id}：${u}`)));
  const active = latestSources(state.sources).map(s => `${s.id}@${s.revision}`);
  if (active.some(v => !draft.sourceVersions.includes(v))) lines.push('- 材料已新增或修正，本稿尚未据最新文字重新整理；旧引用仍指向旧版本。');
  lines.push('', '## 要你拍板 / 下一步', '', ...draft.next.map(s => `- [ ] ${s}`), '', '## 人工决定（不改变证据层级）', '');
  lines.push(...state.decisions.filter(d => d.version <= draft.version).map(d => `- v${d.version} ${d.claimId}：${d.choice}；${d.note}`));
  lines.push('', '## 【勘误】', '');
  for (const e of state.errata.filter(e => e.version <= draft.version)) {
    lines.push(`- 【勘误】原主张 / 原表述：${e.original}\n  - 【错因】${e.cause}\n  - 【改后】${e.corrected}\n  - 【影响面】${e.impact}`);
    const id = /^([A-Za-z0-9_-]+):/.exec(e.original)?.[1];
    const old = state.drafts.find(d => d.version === e.version - 1)?.claims.find(c => c.id === id), next = state.drafts.find(d => d.version === e.version)?.claims.find(c => c.id === id);
    if (old && next && old.text === next.text) {
      const changes = claimChanges(old, next);
      if (changes.length) lines.push(`  - 旧记录展示澄清（由版本对比派生，旧事件未改）：正文未改；${changes.map(c => `${c.field}由「${c.before}」改为「${c.after}」`).join('；')}`);
    }
  }
  lines.push('', '## 来源与覆盖索引', '');
  for (const s of state.sources.filter(s => draft.sourceVersions.includes(`${s.id}@${s.revision}`))) lines.push(`- ${s.id}@${s.revision} · ${s.name} · ${s.locator} · ${s.method} · ${s.coverage}；原件：${s.original}；页图：${s.preview ?? '文本原件'}；sha256 ${s.originalSha256}`);
  if (state.pending) lines.push('', `本轮仍有在途请求：${state.pending}；此处展示最后有效稿。`);
  if (state.failures.length) lines.push('', `## 累计/历史失败记录（${state.failures.length}轮，不代表本轮失败）`, '', ...state.failures.map((f, i) => `- 历史第${i + 1}轮：${f}`));
  const unused = latestSources(state.sources).filter(s => !draft.sourceVersions.includes(`${s.id}@${s.revision}`));
  if (unused.length) lines.push('', '## 已新增但尚未纳入本稿的来源', '', ...unused.map(s => `- ${s.id}@${s.revision} · ${s.name} · ${s.locator} · ${s.coverage}；sha256 ${s.sha256}`));
  lines.push('', '## 稿件元数据（代码记录）', '', '```json', JSON.stringify({ version: draft.version, requestId: draft.requestId, sourceVersions: draft.sourceVersions, referenceContract: draft.referenceContract, rulesHash: draft.rulesHash }, null, 2), '```');
  lines.push('', '## 完整定位证据（由代码重算，非模型知识）', '', '```json', JSON.stringify({ claims: draft.claims.map(c => ({ id: c.id, citations: c.citations, ...(c.citationNote !== undefined ? { citationNote: c.citationNote } : {}) })), conflicts: draft.conflicts }, null, 2), '```');
  lines.push('', closing, ''); return lines.join('\n');
}
export function renderStudy(state: State, draft: Draft | undefined = state.drafts.at(-1), links: { audit?: string; sources?: string } = {}): string {
  if (!draft) return `尚无有效学习单。已导入${latestSources(state.sources).length}个切片。${state.pending ? `在途请求 ${state.pending}，用 abandon / retry 处理。` : ''}`;
  const audit = links.audit ?? 'audit.md', sources = links.sources ?? 'sources.md';
  const lines = [`# ${draft.title.endsWith('学习钉子单') ? draft.title : draft.title + '学习钉子单'}`, `> 学习版 · v${draft.version} · 材料尚未核对教材，引用位置通过不等于整句有依据。`, '', draft.status, '', `[查逐句依据与修订记录](${audit}) · [查全部来源文字版本](${sources})`];
  for (const [section, title] of [['concept', '概念钉子'], ['backbone', '主干'], ['pitfall', '易错对照']] as const) {
    lines.push('', `## ${title}`, '');
    for (const c of draft.claims.filter(c => c.section === section)) {
      const kinds = [...new Set(c.citations.map(r => state.sources.find(s => s.id === r.sourceId && s.revision === r.revision)?.kind))];
      const label = c.origin === 'ai' ? '我补的，待你核对' : kinds.includes('ocr') ? '材料（转写识别待核）' : kinds.every(k => k === 'note') ? '材料·笔记（未核教材）' : '材料·讲义（未核教材）';
      lines.push(`- **[${c.id}] ${label}**：${c.text}`);
      if (c.citations.length) {
        const refs = [...new Map(c.citations.map(r => { const s = state.sources.find(s => s.id === r.sourceId && s.revision === r.revision); return [`${r.sourceId}@${r.revision}`, `${s?.name ?? r.sourceId} · ${s?.locator ?? '来源待查'} · ${r.sourceId}@${r.revision}`]; })).values()];
        lines.push(`  - 出处：[${refs.join('；')}](${audit}#claim-${c.id})`);
      }
      if (c.citationNote !== undefined) lines.push(`  - 附[模型待审注释（非教材依据）](${audit}#claim-${c.id})。`);
      lines.push('');
    }
  }
  lines.push('## 另一种说法 / 材料冲突', '', ...(draft.conflicts.length ? draft.conflicts.map(c => `- ${c.text}`) : ['本版未列出冲突；这不代表全文没有冲突。']), '', `冲突两侧原文见[审计版](${audit})。`, '', '## 还不能当真的地方', '', ...draft.uncertainties.map(s => `- ${s}`));
  for (const s of latestSources(state.sources)) for (const u of s.uncertainties) lines.push(`- ${s.id}：${u}`);
  if (latestSources(state.sources).some(s => !draft.sourceVersions.includes(`${s.id}@${s.revision}`))) lines.push('- 材料已新增或修正，本稿尚未据最新文字重新整理；旧引用仍指向旧版本。');
  lines.push('', '## 要你拍板 / 下一步', '', ...draft.next.map(s => `- [ ] ${s}`));
  const decisions = [...new Map(state.decisions.filter(d => d.version <= draft.version).map(d => [d.claimId, d])).values()];
  if (decisions.length) lines.push('', '## 当前人工决定（不改变证据层级）', '', ...decisions.map(d => `- v${d.version} ${d.claimId}：${d.choice}；${d.note}`));
  const errata = state.errata.filter(e => e.version <= draft.version);
  if (errata.length) lines.push('', `【勘误】累计${errata.length}条，[原表述、错因、改后与影响面](${audit})均保留。`);
  if (state.pending) lines.push('', '本轮仍有在途请求；此处展示最后有效稿。');
  if (state.failures.length) lines.push('', `累计/历史失败记录：${state.failures.length}轮，不代表本轮失败；最后有效稿保留，详情见[审计版](${audit})和请求记录。`);
  lines.push('', closing, ''); return lines.join('\n');
}
