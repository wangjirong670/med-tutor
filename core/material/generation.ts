import { z } from 'zod';
import { citationSchema, claimSchema, draftSchema, inspectDraft, type DraftInspection, type Source } from './model.js';
export const GENERATION_OUTPUT_VERSION = 'generation-output-v1';
export const generationCitationSchema = citationSchema.pick({ sourceId: true, revision: true, quote: true, fragmentId: true, before: true, after: true }).strict();
export const generationSchema = draftSchema.extend({ claims: z.array(claimSchema.extend({ citations: z.array(generationCitationSchema) }).strict()).min(1), conflicts: z.array(z.object({ text: z.string().min(1), sides: z.array(generationCitationSchema).min(2) }).strict()) }).strict();
const legacyEnvelope = generationSchema.extend({ version: z.number().int().positive().optional(), requestId: z.string().optional(), sourceVersions: z.array(z.string()).optional(), rulesNote: z.string().optional(), rulesHash: z.string().optional(), referenceContract: z.literal('refs-v2').optional() }).strict();
export type OutputMode = 'generation-output-v1' | 'legacy-envelope-v1';
export function inspectGeneration(raw: string, sources: Source[], options: { finishReason?: string; outputMode?: OutputMode } = {}): DraftInspection {
  const finishReason = options.finishReason ?? 'unknown';
  const failure = (code: string, message: string, completion = 'complete', schema = 'not-run'): DraftInspection => ({ ok: false, semanticStatus: 'not-reviewed', finishReason, stages: { completion, schema, references: 'not-run' }, issues: [{ code, path: '$', message }], references: [] });
  if (finishReason === 'length') return failure('OUTPUT_TRUNCATED', '服务finish_reason=length：输出额度耗尽；原文保留，不补JSON或接收局部。先减少重复审计回传并核对输出契约，再由用户决定是否显式重试。', 'truncated');
  if (!['stop', 'unknown'].includes(finishReason)) return failure('INCOMPLETE_RESPONSE', `服务未正常完成（finish_reason=${finishReason}）；保留旧稿，检查服务完成原因后显式重试。`, 'incomplete');
  if (!raw.trim()) return failure('EMPTY_RESPONSE', '模型未返回正文；保留旧稿，检查完成原因与用量后显式重试。', finishReason === 'unknown' ? 'unknown' : 'complete');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { return failure('JSON_INVALID', '正文不是合法JSON；未观察到length时不能擅自认定截断；不修补原文，保留旧稿。', finishReason === 'unknown' ? 'unknown' : 'complete', 'failed'); }
  const check = (options.outputMode === 'legacy-envelope-v1' ? legacyEnvelope : generationSchema).safeParse(parsed);
  if (!check.success) return { ok: false, semanticStatus: 'not-reviewed', finishReason, stages: { completion: finishReason === 'unknown' ? 'unknown' : 'complete', schema: 'failed', references: 'not-run' }, issues: check.error.issues.flatMap(i => i.code === 'unrecognized_keys' ? i.keys.map(k => ({ code: 'SCHEMA', path: [...i.path, k].join('.'), message: `未允许的额外字段：${k}` })) : [{ code: 'SCHEMA', path: i.path.join('.'), message: i.message }]), references: [] };
  const { title, status, claims, conflicts, uncertainties, next } = check.data;
  const inspection = inspectDraft({ title, status, claims, conflicts, uncertainties, next }, sources);
  const modelMetadata = options.outputMode === 'legacy-envelope-v1' ? Object.fromEntries(Object.entries(check.data).filter(([k]) => ['version', 'requestId', 'sourceVersions', 'rulesNote', 'rulesHash', 'referenceContract'].includes(k))) : undefined;
  return { ...inspection, ...(modelMetadata && Object.keys(modelMetadata).length ? { modelMetadata } : {}), finishReason, stages: { completion: finishReason === 'unknown' ? 'unknown' : 'complete', schema: 'passed', references: inspection.ok ? 'passed' : 'failed' } };
}
