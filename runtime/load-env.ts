/**
 * 最小 .env 加载：把 .env 里的键补进 process.env。
 * 规则：进程环境已有同名变量时优先（CI / 终端临时覆盖）；不引第三方依赖。
 * Key 只存在 .env（已 gitignore），不进代码与文档。
 *
 * 支持的写法：
 *   KEY=value
 *   KEY="value with spaces"      / KEY='value'
 *   export KEY=value
 *   KEY=value   # 行内注释
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    if (process.env[key] !== undefined) continue;

    let value = m[2]!.trim();
    if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1); // 引号内原样保留（允许 # 与空格）
    } else {
      value = value.replace(/\s+#.*$/, '').trim(); // 只去「空白 + #」后的行内注释
    }
    process.env[key] = value;
  }
}
