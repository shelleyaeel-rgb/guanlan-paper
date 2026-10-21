const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validState } = require('./engine.cjs');
function fileIdentity(file) {
  const stat = fs.statSync(file, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
}
const sameFile = (left, right) => left && right && left.every((value, index) => value === right[index]);
function syncedCopy(source, target, flags) {
  fs.copyFileSync(source, target, flags);
  const fd = fs.openSync(target, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const renameRetryDelays = [50, 100, 200, 400];
const renameRetryCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
const renameWait = new Int32Array(new SharedArrayBuffer(4));
function replaceFileSync(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || !renameRetryCodes.has(error.code) || attempt >= renameRetryDelays.length) throw error;
      // Keep the synchronous account transaction exclusive. Only retry the
      // atomic rename, never the trade or backup, and never delete the target.
      // External Windows handles can close while this thread waits (750ms max).
      Atomics.wait(renameWait, 0, 0, renameRetryDelays[attempt]);
    }
  }
}
class Store {
  constructor(dir, { decode = value => value } = {}) { fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'account.json'); this.warning = ''; this.decode = decode; this.validatedFile = null; this.validatedVersion = null; }
  read(file) { const state = this.decode(JSON.parse(fs.readFileSync(file, 'utf8'))); if (!validState(state)) throw Error('数据校验失败'); return state; }
  load() {
    if (!fs.existsSync(this.file)) {
      if (!fs.existsSync(this.file + '.bak')) return null;
      try {
        const state = this.read(this.file + '.bak');
        this.warning = '账户主文件缺失，已恢复上一份自动备份。';
        return state;
      } catch { throw Error('账户主文件缺失，自动备份无法读取。备份已保留，请检查数据目录；程序没有重置账户。'); }
    }
    try { return this.read(this.file); }
    catch (e) {
      try { const s = this.read(this.file + '.bak'); fs.copyFileSync(this.file, this.file + `.corrupt-${Date.now()}`); this.warning = '账户文件异常，已保留原文件并恢复上一份自动备份。'; return s; }
      catch { throw Error('账户文件和备份无法读取。原文件已保留，请检查数据目录；程序没有重置账户。'); }
    }
  }
  save(s) {
    try {
      if (!validState(s)) throw Error('拒绝保存无效账户');
      const tmp = this.file + '.tmp';
      const fd = fs.openSync(tmp, 'w'); try { fs.writeFileSync(fd, JSON.stringify(s, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      let replaced = false, good = false;
      if (fs.existsSync(this.file)) {
        // A successful save already validated this exact file. Check identity
        // before reusing that result; ctime also catches a restored mtime.
        let identity;
        try { identity = fileIdentity(this.file); } catch {}
        good = sameFile(this.validatedFile, identity); let previousVersion = good ? this.validatedVersion : null;
        // Revalidate unknown files before allowing them to replace a good backup.
        if (!good || previousVersion == null) try { const prior = JSON.parse(fs.readFileSync(this.file, 'utf8')); good = validState(prior); previousVersion = prior.version; } catch { good = false; }
        if (good && s.version > previousVersion) { this.saveUpgrade(tmp, s.version, this.file); replaced = true; }
        else if (good) fs.copyFileSync(this.file, this.file + '.bak');
      }
      if (!good && s.version >= 2 && fs.existsSync(this.file + '.bak')) {
        // Recovery may have loaded an old valid backup while the primary is
        // corrupt or missing. Protect that source during a version upgrade.
        let backup;
        try { backup = JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8')); } catch {}
        if (validState(backup) && backup.version < s.version) { this.saveUpgrade(tmp, s.version, this.file + '.bak'); replaced = true; }
      }
      if (!replaced) replaceFileSync(tmp, this.file);
      // Failure to inspect the committed file only disables the optimization;
      // it must not turn an already completed commit into a reported failure.
      try { this.validatedFile = fileIdentity(this.file); this.validatedVersion = s.version; } catch { this.validatedFile = null; this.validatedVersion = null; }
    } catch (error) {
      this.validatedFile = null; this.validatedVersion = null;
      throw error;
    }
  }
  saveUpgrade(tmp, version, source) {
    const nonce = `${Date.now()}-${randomUUID()}`, backup = this.file + '.bak';
    const archive = path.join(path.dirname(this.file), `account-before-v${version}-${nonce}.json`);
    const stagedBackup = backup + `.upgrade-${nonce}`, rollback = backup + `.rollback-${nonce}`;
    let hadBackup = false, backupReplaced = false, keepRollback = false;
    try {
      // An old executable must never recover an old-version automatic backup
      // after rejecting a successfully upgraded primary. Keep old bytes only
      // under a separate, uniquely named manual recovery archive.
      syncedCopy(source, archive, fs.constants.COPYFILE_EXCL);
      hadBackup = fs.existsSync(backup);
      if (hadBackup) fs.copyFileSync(backup, rollback, fs.constants.COPYFILE_EXCL);
      syncedCopy(tmp, stagedBackup, fs.constants.COPYFILE_EXCL);
      replaceFileSync(stagedBackup, backup); backupReplaced = true;
      replaceFileSync(tmp, this.file);
    } catch (error) {
      // Until the primary rename succeeds there is no committed upgrade.
      // Restore the previous automatic backup so retry/recovery cannot apply
      // an addition that the transaction reported as failed.
      if (backupReplaced) {
        try { if (hadBackup) syncedCopy(rollback, backup); else fs.unlinkSync(backup); }
        catch (restoreError) { keepRollback = true; throw Error(`${error.message}；升级自动备份回滚失败：${restoreError.message}；原始账户保存在 ${archive}`); }
      }
      throw error;
    } finally {
      for (const file of [stagedBackup, ...(!keepRollback ? [rollback] : [])]) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
      }
    }
  }
  backup(s) { const file = this.file.replace('account.json', `account-backup-${Date.now()}.json`); fs.writeFileSync(file, JSON.stringify(s, null, 2)); return file; }
}
module.exports = { Store };
