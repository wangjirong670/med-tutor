import fs from 'node:fs';
export async function readCloseRequest(file, { read = (p) => fs.readFileSync(p, 'utf8'), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 2000, now = () => Date.now() } = {}) {
  const started=now(); let attempts=0; let lastError;
  while (now()-started < timeoutMs) {
    attempts++;
    try { return {request:JSON.parse(read(file).replace(/^\uFEFF/, '')), attempts, elapsedMs:now()-started}; }
    catch (error) { lastError=error; if (!['EBUSY','EACCES','EPERM','ENOENT'].includes(error.code)) break; await delay(50); }
  }
  throw Object.assign(new Error(`close request read failed after ${attempts} attempts: ${lastError}`), {code:lastError?.code, attempts, elapsedMs:now()-started});
}
