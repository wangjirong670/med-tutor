import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from './load-env.js';

let dir: string | undefined;
let touchEnv = false;

const write = (text: string) => {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'env-'));
  const p = join(dir, '.env');
  writeFileSync(p, text, 'utf8');
  return p;
};

beforeEach(() => {
  touchEnv = false;
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  if (touchEnv) {
    delete process.env.MED_TEST_KEY;
    delete process.env.MED_TEST_QUOTED;
    delete process.env.MED_TEST_EXPORT;
    delete process.env.MED_TEST_INLINE;
    delete process.env.MED_TEST_KEEP;
  }
});

describe('loadDotEnv', () => {
  it('读普通键值', () => {
    touchEnv = true;
    loadDotEnv(write('MED_TEST_KEY=abc123\n'));
    expect(process.env.MED_TEST_KEY).toBe('abc123');
  });

  it('进程已有同名变量 → 不覆盖（终端/CI 优先）', () => {
    touchEnv = true;
    process.env.MED_TEST_KEY = 'from-shell';
    loadDotEnv(write('MED_TEST_KEY=from-file\n'));
    expect(process.env.MED_TEST_KEY).toBe('from-shell');
  });

  it('去引号，引号内 # 与空格保留', () => {
    touchEnv = true;
    loadDotEnv(write("MED_TEST_QUOTED='a b # not comment'\n"));
    expect(process.env.MED_TEST_QUOTED).toBe('a b # not comment');
  });

  it('支持 export 前缀', () => {
    touchEnv = true;
    loadDotEnv(write('export MED_TEST_EXPORT=yes\n'));
    expect(process.env.MED_TEST_EXPORT).toBe('yes');
  });

  it('去行内注释（仅未加引号时）', () => {
    touchEnv = true;
    loadDotEnv(write('MED_TEST_INLINE=https://x/v1  # 备注\n'));
    expect(process.env.MED_TEST_INLINE).toBe('https://x/v1');
  });

  it('忽略注释行与空行，不炸', () => {
    touchEnv = true;
    expect(() => loadDotEnv(write('# 注释\n\n  \nMED_TEST_KEEP=1\n'))).not.toThrow();
    expect(process.env.MED_TEST_KEEP).toBe('1');
  });

  it('文件不存在 → 静默返回', () => {
    expect(() => loadDotEnv(join(tmpdir(), 'definitely-not-exist', '.env'))).not.toThrow();
  });
});
