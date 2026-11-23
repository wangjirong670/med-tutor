import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Source } from '../../core/material/model.js';
import { hash, type Session } from './store.js';

const exec = promisify(execFile);
export function pythonPath(): string {
  const bundled = join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  return process.env.MED_STUDY_PYTHON ?? (existsSync(bundled) ? bundled : 'python');
}
async function run(command: string, args: string[]): Promise<string> {
  try { return (await exec(command, args, { encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch { throw Error(`本地导入工具失败：${basename(command)}；检查 Python/pdfplumber、Poppler、Windows OCR 语言及图像尺寸`); }
}
export function pageRange(value: string | undefined, count: number): number[] {
  if (!value && count > 10) throw Error(`PDF 共${count}页，指定 --pages（每批最多10页），不会截取`);
  const pages = new Set<number>();
  for (const chunk of (value ?? `1-${count}`).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(chunk);
    if (!m) throw Error('页范围格式例：1-3,5');
    const from = Number(m[1]), to = Number(m[2] ?? m[1]);
    if (from < 1 || to < from || to > count || to - from > 10) throw Error('页范围越界或超过10页');
    for (let n = from; n <= to; n++) pages.add(n);
  }
  if (pages.size > 10) throw Error('每批最多10页，不会截取');
  return [...pages].sort((a, b) => a - b);
}
export function decodeText(data: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, ''); }
  catch { throw Error('文本须为 UTF-8；未导入'); }
}
export async function importMaterials(session: Session, paths: string[], pasted?: string, pages?: string, language = 'zh-Hans-CN'): Promise<Source[]> {
  if (!paths.length && pasted === undefined) throw Error('提供 --file 或 --stdin/--text');
  if (paths.filter(p => ['.png', '.jpg', '.jpeg'].includes(extname(p).toLowerCase())).length > 5) throw Error('每批最多5张图片，不会截取');
  if (paths.filter(p => extname(p).toLowerCase() === '.pdf').length > 1) throw Error('每批一个 PDF，按页分批');
  const items = paths.map(path => {
    if (statSync(path).size > 20 * 1024 * 1024) throw Error('单文件超过20 MiB，请分批');
    const ext = extname(path).toLowerCase();
    if (!['.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg'].includes(ext)) throw Error('仅支持 TXT/MD/PDF/PNG/JPEG');
    return { name: basename(path), ext, data: readFileSync(path) };
  });
  if (pasted !== undefined) {
    const data = Buffer.from(pasted); if (data.length > 20 * 1024 * 1024) throw Error('粘贴超过20 MiB');
    items.push({ name: '粘贴文本', ext: '.txt', data });
  }
  const sources: Source[] = [];
  const before = session.read().state.sources.length;
  for (const item of items) {
    const digest = hash(item.data); const original = `originals/${digest}${item.ext}`;
    session.file(original, item.data);
    const make = (text: string, locator: string, kind: Source['kind'], method: string, extra: Partial<Source> = {}): Source => ({ id: `s${before + sources.length + 1}-${randomUUID().slice(0, 6)}`, revision: 1, name: item.name, locator, kind, text, sha256: hash(text), original, originalSha256: digest, method, coverage: text.trim() ? '本页文字已提取，语义/版式/遗漏待核' : '未识别出文字；未闭合，需补录', uncertainties: ['尚未核对教材；仅处理当前切片，不代表全文'], ...extra });
    if (['.txt', '.md'].includes(item.ext)) {
      sources.push(make(decodeText(item.data), '全文', 'note', 'UTF-8 原文')); continue;
    }
    const ocr = async (image: string) => JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/windows-ocr.ps1'), '-ImagePath', image, '-Language', language])) as { text: string; lines: Source['lines']; width: number; height: number };
    if (item.ext !== '.pdf') {
      const result = await ocr(join(session.dir, original));
      sources.push(make(result.text, '图片1', 'ocr', `Windows OCR ${language}`, { ...result, preview: original, uncertainties: ['转写自图片；形近字、读不清/未识别区域须原图核对；OCR 不提供置信度', '表格行列与插图含义未识别，不能据文字推断关系；尚未核对教材'] })); continue;
    }
    const pdf = join(session.dir, original);
    const helper = resolve('scripts/material_pdf.py');
    const count = (JSON.parse(await run(pythonPath(), [helper, pdf])) as { pages: number }).pages;
    const selection = pageRange(pages, count);
    for (const page of selection) {
      const extracted = JSON.parse(await run(pythonPath(), [helper, pdf, String(page)])) as { text: string; hasRaster: boolean };
      const rel = `previews/${digest}-p${page}`;
      mkdirSync(join(session.dir, 'previews'), { recursive: true });
      await run(process.env.MED_STUDY_PDFTOPPM ?? 'pdftoppm', ['-f', String(page), '-l', String(page), '-scale-to', '2400', '-singlefile', '-png', pdf, join(session.dir, rel)]);
      const preview = `${rel}.png`;
      if (extracted.hasRaster || extracted.text.trim().length < 30) {
        const result = await ocr(join(session.dir, preview));
        const mixed = extracted.text.trim().length > 0;
        const text = mixed ? `${extracted.text}\n\n[以下为整页 OCR，可能与提取文字重复]\n${result.text}` : result.text;
        sources.push(make(text, `PDF物理页${page}/${count}`, 'ocr', mixed ? 'pdfplumber + Windows OCR（混合页）' : 'Windows OCR（扫描页）', { ...result, text, preview, uncertainties: ['转写自扫描；字形、阅读顺序、未识别区域须对照页图；无置信度', '表格行列与插图含义未识别；混合文字可能重复；仅当前页范围，教材尚未核对'] }));
      } else {
        sources.push(make(extracted.text, `PDF物理页${page}/${count}`, 'document', 'pdfplumber', { preview, uncertainties: ['文本层阅读顺序/表格行列/矢量插图须对照页图核对；可能有未提取区域；未核对教材'] }));
      }
    }
  }
  return sources;
}
