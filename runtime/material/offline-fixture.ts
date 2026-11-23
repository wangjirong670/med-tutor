import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MaterialProvider } from './provider.js';

/** Explicit UI fixture only. Never selected by a production request or fallback. */
export function offlineFixtureProvider(logPath: string): MaterialProvider {
  return { model: 'offline-fixture-no-supplier', async generate(_system, user, signal) {
    const input = JSON.parse(user);
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), offline: true, network: false, action: input.action, question: input.question }) + '\n');
    if (input.question.includes('模拟等待')) await new Promise<void>((resolve,reject) => { const timer=setTimeout(resolve,input.question.includes('长等待')?30000:4000);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('离线等待已停止'));},{once:true}); });
    if (input.question.includes('模拟失败')) throw Error('离线fixture模拟失败：未连接供应商');
    const blocks = [{ text: `这是离线界面演示，未请求真实模型。你刚才问：“${input.question}”。前面保留了${input.conversation.length}轮讨论、${input.sources.length}份材料。`, origin: 'ai', citations: [] }];
    const draft = input.action === 'organize' ? { title: '离线示例学习单', status: '离线fixture，仅验证页面操作', claims: [{ id: 'offline_concept', section: 'concept', text: '本示例只验证对话能收进学习单，不验证医学内容。', origin: 'ai', citations: [] }], conflicts: [], uncertainties: ['离线演示，没有真实模型教学质量结论'], next: ['回到对话可以继续提问'] } : null;
    return { model: 'offline-fixture-no-supplier', raw: JSON.stringify(input.question.includes('模拟引用失败') ? {blocks:[{text:'无效引用',origin:'material',citations:[{sourceId:'absent',revision:1,quote:'不存在'}]}],draft:null} : input.question.includes('省略draft') ? {blocks} : { blocks, draft }), ms: 1, finishReason: 'stop' };
  } };
}
