const fs = require('node:fs');
const path = require('node:path');
const { validState } = require('./engine.cjs');
class Store {
  constructor(dir) { fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'account.json'); this.warning = ''; }
  load() {
    if (!fs.existsSync(this.file)) return null;
    try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!validState(s)) throw Error('数据校验失败'); return s; }
    catch (e) {
      try { const s = JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8')); if (!validState(s)) throw Error('备份校验失败'); fs.copyFileSync(this.file, this.file + `.corrupt-${Date.now()}`); this.warning = '账户文件异常，已保留原文件并恢复上一份自动备份。'; return s; }
      catch { throw Error('账户文件和备份无法读取。原文件已保留，请检查数据目录；程序没有重置账户。'); }
    }
  }
  save(s) {
    if (!validState(s)) throw Error('拒绝保存无效账户');
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w'); try { fs.writeFileSync(fd, JSON.stringify(s, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(this.file)) {
      // Never overwrite a good backup with the corrupt file we just recovered from.
      let good = false;
      try { good = validState(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch {}
      if (good) fs.copyFileSync(this.file, this.file + '.bak');
    }
    fs.renameSync(tmp, this.file);
  }
  backup(s) { const file = this.file.replace('account.json', `account-backup-${Date.now()}.json`); fs.writeFileSync(file, JSON.stringify(s, null, 2)); return file; }
}
module.exports = { Store };
