import { existsSync, mkdirSync, readdirSync, readFileSync, openSync, closeSync, fsyncSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomic, hash } from './store.js';

export class PersonalUsage {
  constructor(readonly root: string) {}
  private read() {
    const settingsDir = join(this.root, 'settings'), usageDir = join(this.root, 'usage');
    let previous = '', limit: number | undefined;
    const files = existsSync(settingsDir) ? readdirSync(settingsDir).filter(f => f.endsWith('.json')).sort() : [];
    files.forEach((file, index) => {
      const entry = JSON.parse(readFileSync(join(settingsDir, file), 'utf8'));
      const { hash: digest, ...body } = entry;
      if (file !== `${String(index + 1).padStart(6, '0')}.json` || body.seq !== index + 1 || body.previous !== previous || digest !== hash(JSON.stringify(body)) || body.confirmed !== true || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 10000) throw Error('个人用量设置记录损坏，暂停发送；不会重置');
      previous = digest; limit = body.limit;
    });
    const reservations = existsSync(usageDir) ? readdirSync(usageDir).filter(f => f.endsWith('.reserved.json')).sort() : [];
    reservations.forEach((file, index) => {
      const record = JSON.parse(readFileSync(join(usageDir, file), 'utf8'));
      if (file !== `${String(index + 1).padStart(6, '0')}.reserved.json` || record.seq !== index + 1 || record.mode !== 'personal' || typeof record.requestId !== 'string') throw Error('个人使用记录缺失或损坏，暂停发送；不会重新计数');
    });
    if (reservations.length && limit === undefined) throw Error('已有用量但启用记录缺失，暂停发送');
    return { limit, used: reservations.length, settingsCount: files.length, previous };
  }
  status() {
    const s = this.read();
    return { enabled: s.limit !== undefined, limit: s.limit ?? null, used: s.used, remaining: s.limit === undefined ? 0 : Math.max(0, s.limit - s.used) };
  }
  private locked<T>(fn: () => T): T {
    mkdirSync(this.root, { recursive: true }); const path = join(this.root, 'usage.lock');
    try { mkdirSync(path); } catch { throw Error('用量设置正被写入，请稍后重试；不会重复发送'); }
    try { return fn(); } finally { rmSync(path, { recursive: true }); }
  }
  confirmLimit(limit: number, confirmed: boolean) {
    if (confirmed !== true) throw Error('请本人在页面确认个人试用上限');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw Error('累计上限需为1–10000的整数');
    return this.locked(() => {
      const s = this.read(); if (limit < s.used) throw Error(`累计上限不能低于已用${s.used}次，已用记录不会清零`);
      const dir = join(this.root, 'settings'); mkdirSync(dir, { recursive: true });
      const body = { seq: s.settingsCount + 1, previous: s.previous, at: new Date().toISOString(), confirmed: true, limit, usedAtConfirmation: s.used };
      atomic(join(dir, `${String(body.seq).padStart(6, '0')}.json`), JSON.stringify({ ...body, hash: hash(JSON.stringify(body)) }, null, 2));
      if (!existsSync(join(this.root, 'personal-mode.json'))) atomic(join(this.root, 'personal-mode.json'), JSON.stringify({ mode: 'personal', purpose: '使用个人累计账本；禁止默认开发预算' }));
      return this.status();
    });
  }
  assertAvailable() {
    const s = this.status();
    if (!s.enabled) throw Error('个人试用尚未启用，请在页面选择上限并确认');
    if (!s.remaining) throw Error(`已用${s.used}/${s.limit}次，请在使用设置中调整累计上限后继续`);
  }
  reserve(requestId: string, sessionId: string, model: string) {
    return this.locked(() => {
      this.assertAvailable(); const s = this.status(), seq = s.used + 1;
      const dir = join(this.root, 'usage'); mkdirSync(dir, { recursive: true });
      const fd = openSync(join(dir, `${String(seq).padStart(6, '0')}.reserved.json`), 'wx');
      try { writeFileSync(fd, JSON.stringify({ seq, requestId, sessionId, model, mode: 'personal', at: new Date().toISOString(), limitAtReservation: s.limit })); fsyncSync(fd); } finally { closeSync(fd); }
      return seq;
    });
  }
}
