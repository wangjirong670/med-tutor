import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emptyState, fold, type Event, type State } from '../../core/material/model.js';

export const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export function atomic(path: string, value: string | Buffer): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx');
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
export type Envelope = { seq: number; previous: string; event: Event; hash: string };
export class Session {
  readonly dir: string;
  constructor(readonly root: string, readonly id: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error('session 只允许字母、数字、横线、下划线，最多80字符');
    this.dir = resolve(root, 'sessions', id);
  }
  read(): { state: State; events: Envelope[] } {
    const dir = join(this.dir, 'events');
    const files = existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith('.json')).sort() : [];
    let state = emptyState(); const events: Envelope[] = [];
    for (const f of files) {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Envelope;
      if (f !== `${String(events.length + 1).padStart(6, '0')}.json` || e.seq !== events.length + 1 || e.previous !== (events.at(-1)?.hash ?? '') || e.hash !== hash(JSON.stringify({ seq: e.seq, previous: e.previous, event: e.event }))) throw Error(`事件损坏或缺失：${f}，停止回放`);
      state = fold(state, e.event); events.push(e);
    }
    return { state, events };
  }
  append(event: Event): void {
    const { state, events } = this.read(); fold(state, event);
    mkdirSync(join(this.dir, 'events'), { recursive: true });
    const data = { seq: events.length + 1, previous: events.at(-1)?.hash ?? '', event };
    atomic(join(this.dir, 'events', `${String(data.seq).padStart(6, '0')}.json`), JSON.stringify({ ...data, hash: hash(JSON.stringify(data)) }, null, 2));
  }
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    mkdirSync(this.dir, { recursive: true });
    const lock = join(this.dir, 'write.lock');
    try { mkdirSync(lock); } catch { throw Error('会话被锁定；若旧进程已退出，运行 unlock --confirm'); }
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    try { return await fn(); } finally { rmSync(lock, { recursive: true }); }
  }
  unlock(): void {
    const lock = join(this.dir, 'write.lock');
    if (!existsSync(lock)) return;
    const owner = join(lock, 'owner.json');
    if (existsSync(owner)) {
      const { pid } = JSON.parse(readFileSync(owner, 'utf8')) as { pid: number };
      let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) throw Error('锁持有进程仍存在，拒绝解锁');
    }
    rmSync(lock, { recursive: true });
  }
  file(relative: string, value: string | Buffer): void {
    // Internal paths only; user-controlled filenames never enter this function.
    const path = resolve(this.dir, relative);
    if (!path.startsWith(this.dir + '\\') && !path.startsWith(this.dir + '/')) throw Error('文件越出会话');
    mkdirSync(resolve(path, '..'), { recursive: true }); atomic(path, value);
  }
}
export function reserveRequest(root: string): number {
  if (existsSync(join(root, 'personal-mode.json'))) throw Error('个人模式须使用本人确认后的累计账本，不能使用旧CLI默认预算');
  if (existsSync(join(root, 'batch.json'))) throw Error('明确配置的对话批次不能使用旧CLI生成预算；请用本机对话页面或converse共享本批账本');
  mkdirSync(root, { recursive: true });
  const dir = join(root, 'request-budget'); mkdirSync(dir, { recursive: true });
  // O_EXCL reservation is shared by sessions and counts failed/interrupted calls too.
  for (let n = 1; n <= 10; n++) {
    try { const fd = openSync(join(dir, `${n}.reserved`), 'wx'); writeFileSync(fd, new Date().toISOString()); closeSync(fd); return n; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  throw Error('本批真实请求已达10次预算；停止发送，不自动重置');
}
