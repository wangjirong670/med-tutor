export function makeProcessProbeGuard(deny, observations) {
  return (command, args, options = {}) => {
    const probe = /^\(Get-Process -Id ([1-9][0-9]*) -ErrorAction SilentlyContinue\)\.StartTime\.ToUniversalTime\(\)\.Ticks$/;
    const match = Array.isArray(args) && typeof args[3] === 'string' ? args[3].match(probe) : null;
    if (command === 'powershell.exe' && args?.length === 4 && args[0] === '-NoProfile' && args[1] === '-NonInteractive' && args[2] === '-Command' && match && options.timeout === 500) {
      const error = Object.assign(new Error('policy denied fixed owner incarnation probe'), { code: 'S07B_OFFLINE' });
      observations.push({ pid: Number(match[1]), status: 'unavailable', invoked: false });
      return { pid: 0, status: null, signal: null, stdout: '', stderr: '', output: [null, '', ''], error };
    }
    return deny('child_process.spawnSync')(command, args, options);
  };
}
