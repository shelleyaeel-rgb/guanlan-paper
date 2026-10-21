'use strict';

const { actualAmendment } = require('./company-notice-facts.cjs');

// These checks describe disclosed share-supply events. They neither establish
// independent legal compliance nor turn a disclosed supply change into a buy signal.
const compact = value => String(value || '').normalize('NFKC').replace(/\s+/g, '');
const NUM = '(?<![\\d,.])(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?![\\d,.])';
const amount = (value, unit = '') => {
  const n = Number(value.replaceAll(',', '')) * (unit === '万' ? 10000 : 1);
  return Number.isFinite(n) && n >= 0 && Number.isSafeInteger(Math.round(n)) && Math.abs(n - Math.round(n)) < 1e-5 ? Math.round(n) : null;
};
const DATE = '(20\\d{2})[年./-](\\d{1,2})[月./-](\\d{1,2})日?';
const isoDate = values => {
  const date = `${values[0]}-${values[1].padStart(2, '0')}-${values[2].padStart(2, '0')}`;
  return Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? date : null;
};
const record = entry => ({ page: entry.page, method: entry.method, quote: entry.text.trim() });
const records = entries => [...new Map(entries.map(entry => [JSON.stringify(record(entry)), record(entry)])).values()];
const check = (key, label, value, evidence = [], reason = '', status) => ({ key, label, value,
  status: status || (value == null ? 'missing' : 'verified'), records: records(evidence),
  reason: reason || (value == null ? `${label}尚未可靠识别` : `${label}已按原文核实`) });
const sentences = document => document.pageTexts.flatMap(page => page.text.split(/[。；;]/).map(text => ({ text, value: compact(text), page: page.page, method: page.method }))).filter(entry => entry.value);
const notActual = value => /(?:如果|假如|假设|若|一旦|未来|预计|预期|有望|可能|拟于|拟在|计划于|计划在|将会|将完成|尚需核实|尚未确认|无法确认)/.test(value);

function selectedCheckbox(value, topicPattern) {
  const found = new RegExp(`${topicPattern}[^√☑☒□☐]{0,20}([√☑☒□☐]是[√☑☒□☐]否)`).exec(value);
  if (!found) return null;
  const selected = [...found[1].matchAll(/([√☑☒□☐])(是|否)/g)].filter(match => /[√☑☒]/.test(match[1]));
  return selected.length === 1 ? selected[0][2] === '是' : null;
}

function scopedIssue(entries, document) {
  const adverse = entries.filter(entry => {
    if (selectedCheckbox(entry.value, '是否存在违反减持计划或其他承诺的情况') === true
      || selectedCheckbox(entry.value, '本次减持是否遵守[^√☑☒□☐]{0,60}规定') === false) return true;
    const clauses = entry.value.split(/[，,]|但是|然而|不过|但/);
    return clauses.some(clause => {
      const subject = '(?:本次减持|本次解禁|本次解除限售|相关股东|公司|激励对象)';
      const signals = new RegExp(`${subject}([^，,。；;]{0,20}?)(?:已发生|发生了|存在|违反|构成|导致|造成|被认定)([^，,。；;]{0,12}?)(?:违规减持|违规解禁|违法|违规|重大不利影响|重大损失|资金占用|违规担保|债务违约)|(?:本次减持|本次解除限售)([^，,。；;]{0,12}?)(?:违反(?:了|相关)?|不符合)([^，,。；;]{0,15}?)(?:规定|条件|承诺|计划)`, 'g');
      return [...clause.matchAll(signals)].some(match => {
        const before = clause.slice(0, match.index), link = match[1] ?? match[3] ?? '';
        return !/(?:如果|假如|若|一旦|应当|不得|可能|将会|预计)[^，,。；;]{0,20}$/.test(before)
          && !/(?:不存在|未发生|未出现|没有|不涉及|不会|不得|应当|不能|将会|预计|如|若|一旦)|(?:未|不)$/.test(link);
      });
    });
  });
  if (adverse.length) return { status: 'blocked', code: 'notice-event-blocked', reason: '原文披露本次事项存在实质违规或重大不利事项，不能由完成、解禁或修订事实覆盖', entries: adverse };
  const amendment = entries.filter(entry => actualAmendment({ text: entry.text })
    || /本次(?:减持|解禁|解除限售)(?:计划|事项)?(?:已|已经)变更/.test(entry.value));
  if (actualAmendment(document) || amendment.length) return { status: 'pending', code: 'notice-event-pending', reason: '本次事项存在更正、撤回或计划变更，须先核对生效版本及受影响字段', entries: amendment };
  return null;
}

function periodFrom(value) {
  const match = new RegExp(`${DATE}(?:至|[-—～~])${DATE}`).exec(compact(value));
  if (!match) return null;
  const start = isoDate(match.slice(1, 4)), end = isoDate(match.slice(4, 7));
  return start && end && start <= end ? { start, end } : { invalid: true };
}

function complianceChecks(entries, type) {
  const topic = type === 'unlock' ? '解除限售' : '减持';
  const affirmative = entries.filter(entry => new RegExp(`(?:本次${topic}|减持事项|减持计划|减持股份).{0,30}(?:符合|未违反|已履行|已取得|不存在违规)`).test(entry.value)
    && /法律|法规|规定|程序|授权|承诺|管理办法/.test(entry.value) && !/(?:将|应当|尚未|不符合).{0,8}(?:符合|履行|取得)|未履行|未取得|尚待|待核实|待确认|是否符合/.test(entry.value) && !notActual(entry.value));
  const checkbox = (topicPattern, expected) => entries.filter(entry => selectedCheckbox(entry.value, topicPattern) === expected);
  if (type === 'unlock') {
    affirmative.push(...entries.filter(entry => /本次申请上市流通的限售股.{0,40}符合/.test(entry.value) && /规定|规则/.test(entry.value)
      && !/不符合|尚未|未履行/.test(entry.value)));
    return [check('compliance', '本次解禁已履行程序或符合规定的披露', affirmative.length ? true : null, affirmative)];
  }
  const legal = [...affirmative, ...checkbox('本次减持是否遵守[^√☑☒□☐]{0,60}规定', true)];
  const consistent = entries.filter(entry => /(?:本次(?:实际)?减持(?:情况|事项)?|具体实施情况).{0,60}(?:与|符合).{0,50}(?:计划|承诺|意向).{0,20}(?:一致|不存在.{0,20}不一致)/.test(entry.value)
    && !/(?<!不)存在.{0,15}不一致|与.{0,30}(?:计划|承诺)不一致|是否一致|尚待|待核实|待确认/.test(entry.value) && !notActual(entry.value));
  consistent.push(...checkbox('(?:本次实际减持情况与此前披露的减持计划、承诺是否一致|本次减持事项与股东此前已披露的计划、承诺是否一致)', true));
  const noViolation = entries.filter(entry => /(?:不存在|未出现).{0,8}违反.{0,25}(?:承诺|计划)/.test(entry.value)
    || /本次减持计划实施符合.{0,30}相关承诺[，,]不存在.{0,70}不一致的情形/.test(entry.value));
  noViolation.push(...checkbox('是否存在违反减持计划或其他承诺的情况', false));
  return [check('compliance', '减持合规披露', legal.length ? true : null, legal),
    check('planConsistency', '实际减持与计划一致披露', consistent.length ? true : null, consistent),
    check('noViolation', '不存在违反计划或承诺的披露', noViolation.length ? true : null, noViolation)];
}

function reductionFacts(document, entries) {
  const whole = entries.map(entry => entry.value).join('。'), transactions = [], issues = [];
  const completed = entries.filter(entry => /本次减持计划(?:的)?(?:期限|时间区间)?(?:已|已经)?(?:实施完毕|实施完成|完成|届满)|减持完成情况已完成/.test(entry.value)
    && !/本次减持计划.{0,12}(?:尚未|未完成|预计|拟|将)/.test(entry.value) && !notActual(entry.value));
  const ongoing = entries.filter(entry => /(?:本次减持计划|公司).{0,15}(?:尚未减持|尚未完成|仍在实施|正在实施)|本次减持计划尚在实施/.test(entry.value));
  const stage = completed.length && !ongoing.length ? 'completed' : ongoing.length && !completed.length ? 'ongoing' : 'unknown';
  if (completed.length && ongoing.length) issues.push('同一公告的已完成与进行中阶段陈述冲突');
  const sourceKind = /回购专用证券账户|回购股份集中竞价减持/.test(whole) ? 'issuer-treasury' : 'shareholder';
  const add = (holder, quantityShares, evidence, extra = {}) => {
    if (!holder || quantityShares == null) return;
    if (extra.totalCapitalPct != null && (!Number.isFinite(extra.totalCapitalPct) || extra.totalCapitalPct < 0 || extra.totalCapitalPct > 100)) issues.push(`股东${holder}减持比例超出有效范围`);
    const existing = transactions.find(item => item.holder === holder && item.scope === (extra.scope || 'disclosed-plan'));
    if (existing) {
      if (existing.quantityShares !== quantityShares) issues.push(`股东${holder}同一口径减持数量冲突`);
      if (existing.totalCapitalPct != null && extra.totalCapitalPct != null && existing.totalCapitalPct !== extra.totalCapitalPct) issues.push(`股东${holder}同一口径减持比例冲突`);
      if (existing.period && extra.period && JSON.stringify(existing.period) !== JSON.stringify(extra.period)) issues.push(`股东${holder}同一口径减持期间冲突`);
      if (!existing.period && extra.period) existing.period = extra.period;
      existing.records.push(...records(evidence)); return;
    }
    transactions.push({ holder, quantityShares, scope: 'disclosed-plan', sourceKind, ...extra, records: records(evidence) });
  };
  for (const page of document.pageTexts) {
    const lines = page.text.split(/\r?\n/), kv = lines.map((text, index) => ({ text, value: compact(text), index }));
    for (const item of kv) {
      const quantity = new RegExp(`^减持数量(${NUM})(万?)股$`).exec(item.value);
      if (!quantity) {
        if (/^减持数量[\d+\-]/.test(item.value)) issues.push('减持数量行的单位或数字格式尚未核实');
        continue;
      }
      const before = kv.slice(0, item.index).reverse().find(line => /^股东名称.{2,70}$/.test(line.value));
      if (!before) { issues.push('实际减持数量尚未与股东名称可靠对应'); continue; }
      const after = kv.slice(item.index + 1, item.index + 35);
      const dateLine = after.find(line => /^减持期间/.test(line.value)), ratio = after.map(line => new RegExp(`^减持比例(${NUM})%$`).exec(line.value)).find(Boolean);
      add(before.value.slice(4), amount(quantity[1], quantity[2]), [{ ...page, text: lines.slice(before.index, (dateLine?.index || item.index) + 1).join('\n') }],
        { period: dateLine ? periodFrom(dateLine.value) : null, totalCapitalPct: ratio ? Number(ratio[1].replaceAll(',', '')) : null });
    }
    // Vertically wrapped names and date cells share one physical row group.
    // Require the explicit share-count/total-capital headers; prices and the
    // following before/after holdings table are never treated as sales.
    const start = lines.findIndex(line => /减持股数[（(]股[）)]/.test(line) && /减持股数占总/.test(line));
    if (start >= 0) {
      const end = lines.findIndex((line, index) => index > start && /本次减持前后持股/.test(line));
      const table = lines.slice(start, end < 0 ? lines.length : end);
      const starts = table.flatMap((line, index) => /^\s*集\s+20\d{2}\s*年/.test(line) ? [index] : []);
      starts.forEach((from, index) => {
        const footnote = table.findIndex((line, i) => i > from && /^注[:：]/.test(line));
        const group = table.slice(from, starts[index + 1] ?? (footnote < 0 ? table.length : footnote));
        const holder = group.map(line => /^\s*([\u4e00-\u9fff]{1,2})\s+(?:中|竞|价)\s+/.exec(line)?.[1] || '').join('');
        const numeric = group.map(line => new RegExp(`(${NUM})\\s+(${NUM})\\s+(${NUM})%\\s+(${NUM})%\\s*$`).exec(line)).find(Boolean);
        if (!numeric || !/^[\u4e00-\u9fff]{2,4}$/.test(holder)) { issues.push('实际减持表中存在未可靠识别的股东或数量'); return; }
        const dateText = group.map(line => line.trim().split(/\s{2,}/).find(part => /20\d{2}|月|^日$|^至|^年/.test(part)) || '').join('');
        add(holder, amount(numeric[2]), [{ ...page, text: group.join('\n') }], { period: periodFrom(dateText), totalCapitalPct: Number(numeric[3]) });
      });
    }
  }
  const stageHolder = /(?:获悉|截至[^。；]{0,25}[，,])([\u4e00-\u9fffA-Za-z]{2,30})本次减持计划/.exec(whole)?.[1];
  // A completed sale disclosed in prose is distinct from a planned maximum.
  // The holder must also be explicitly bound to this plan in the same document.
  if (!transactions.length && stageHolder) for (const entry of entries) {
    const match = new RegExp(`本次(?:已)?通过[^，,。；]{1,30}减持公司股份(${NUM})(万?)股[，,]占公司总股本(${NUM})%`).exec(entry.value);
    if (match) add(stageHolder, amount(match[1], match[2]), [entry], { totalCapitalPct: Number(match[3]), period: null });
  }
  // Single-holder horizontal results tables: an explicit total row belongs to
  // the actual-sales section and has its own stated unit. Preserve that total,
  // not a sum of sale rows plus their repeated total.
  if (!transactions.length || transactions.length === 1 && transactions[0].holder === stageHolder) {
    for (const page of document.pageTexts) {
      if (!stageHolder) continue;
      const starts = [...page.text.matchAll(/(?:一、股东减持股份情况|二、股东减持计划实施情况)/g)];
      for (const [sectionIndex, begin] of starts.entries()) {
        const original = page.text.slice(begin.index, starts[sectionIndex + 1]?.index).split(/(?:本次减持前后持股|股东本次减持前后持股)/)[0];
        const scoped = compact(original);
        const namedRows = [...original.matchAll(/^\s*([\u4e00-\u9fffA-Za-z]{2,30})\s+(?:集中竞价(?:交易)?|大宗交易)/gm)].map(match => match[1]);
        if (namedRows.some(holder => holder !== stageHolder)) { issues.push('实际减持表含有其他股东，不能将合计数量归给单一股东'); continue; }
        const unit = /减持股数.{0,30}\(万股\)/.test(scoped) ? '万' : /减持股数.{0,30}\(股\)/.test(scoped) ? '' : null;
        if (unit == null) continue;
        const total = original.split(/\r?\n/).map(line => new RegExp(`^\\s*合\\s*计\\s+(?:${NUM}\\s+)?(${NUM})\\s+(${NUM})%?\\s*$`).exec(line)).filter(Boolean).at(-1);
        if (!total) continue;
        const dates = [...scoped.matchAll(new RegExp(DATE, 'g'))].map(match => isoDate(match.slice(1, 4))).filter(Boolean).sort();
        add(stageHolder, amount(total[1], unit), [{ ...page, text: original }],
          { totalCapitalPct: Number(total[2]), period: dates.length ? { start: dates[0], end: dates.at(-1) } : null });
      }
    }
  }
  // Explicitly distinguished extra share sources are attached to their holder.
  // Their total does not silently acquire the plan-only percentage/date.
  for (const item of transactions) {
    const owned = entries.filter(entry => entry.value.includes(`${item.holder}先生在减持期间内合计减持`) || entry.value.includes(`${item.holder}在减持期间内合计减持`));
    for (const entry of owned) {
      const match = new RegExp(`${item.holder}(?:先生)?在减持期间内合计减持(${NUM})股[，,]其中[:：](${NUM})股.{0,100}?[、，,](${NUM})股.{0,100}?无需减持预披露`).exec(entry.value);
      if (!match) continue;
      const [total, plan, other] = match.slice(1).map(value => amount(value));
      if ([total, plan, other].includes(null) || total !== plan + other || plan !== item.quantityShares) { issues.push(`股东${item.holder}总减持与股份来源明细不一致`); continue; }
      Object.assign(item, { allSourceQuantityShares: total, planQuantityShares: plan, otherSourceQuantityShares: other,
        ratioScope: 'disclosed-plan', periodScope: 'disclosed-plan' });
      item.records.push(record(entry));
    }
    if (owned.some(entry => /其他来源|无需减持预披露/.test(entry.value)) && item.otherSourceQuantityShares == null) issues.push(`股东${item.holder}不同股份来源数量尚未可靠核对`);
  }
  for (const item of transactions) {
    if (!item.period) issues.push(`股东${item.holder}实际减持期间尚未可靠识别`);
    else if (item.period.invalid || item.period.end > document.publishedAt) issues.push(`股东${item.holder}表内减持期间无效或晚于披露日，不能作为实际结束日`);
  }
  const specialSource = /其他来源.{0,80}无需减持预披露|无需减持预披露.{0,80}其他来源/.test(whole);
  if (specialSource && !transactions.some(item => item.otherSourceQuantityShares != null)) issues.push('披露了不同股份来源，但尚未将计划内外数量与同一股东可靠对应');
  const checks = [check('stage', '减持实施阶段', stage === 'unknown' ? null : stage, [...completed, ...ongoing]),
    check('transactions', '分股东及股份来源的实际减持数量', transactions.length ? transactions : null, [], transactions.length ? '数量按股东、计划及其他股份来源分别保留，不跨口径相加' : ''), ...complianceChecks(entries, 'reduction')];
  const actualTotal = transactions.length ? transactions.reduce((sum, item) => sum + (item.allSourceQuantityShares ?? item.quantityShares), 0) : null;
  const observation = transactions.map(item => ({ ...item, records: undefined }));
  return { checks, issues, data: { stage, sourceKind, basis: 'issuer-disclosed-result', independentComplianceVerification: false,
    transactions: observation, quantityShares: actualTotal }, evidence: transactions.flatMap(item => item.records),
    pendingStage: stage !== 'completed', pendingReason: stage === 'ongoing' ? '减持仍在进行或尚未实施，已披露数量保留观察，不能按已完成事件解除门槛' : '缺少唯一明确的已完成或期限届满事实' };
}

function unlockFacts(document, entries) {
  const releases = [], issues = [], declaredPlans = new Set(), quantityClaims = [];
  const titlePlan = /(20\d{2}年[^:：]{0,80}?第[一二三四五六七八九十]+个?解除限售期)/.exec(compact(document.title))?.[1] || '本次解除限售';
  let plan = titlePlan, history = false;
  const active = [];
  for (const page of document.pageTexts) {
    const lines = page.text.split(/\r?\n/);
    let segment = [];
    const flush = () => { if (segment.length && !history) for (const text of segment.join('\n').split(/[。；;]/)) if (compact(text)) active.push({ text, value: compact(text), page: page.page, method: page.method, plan }); segment = []; };
    for (const line of lines) {
      const value = compact(line);
      if (/^[一二三四五六七八九十]+、/.test(value)) {
        flush(); history = /(?:已履行|履行的|审批程序|首次公开发行网下配售股份概况)/.test(value) && !/具体情况/.test(value);
      }
      const heading = /^\([一二三四五六七八九十]+\)(20\d{2}年.{0,100}解除限售)/.exec(value);
      if (heading && /条件|激励计划/.test(value)) { flush(); plan = heading[1]; declaredPlans.add(plan); }
      segment.push(line);
    }
    flush();
  }
  const quantityLabel = '(?:本次(?:可|申请)?(?:解除限售|解禁)(?:的)?(?:限制性)?(?:股票|股份)(?:的)?(?:数量)?(?:为|共计)?|可(?:申请)?解除限售(?:并上市流通)?的(?:限制性)?(?:股票|股份)(?:数量)?(?:为|共计)?|可解除的限制性股票数量为)';
  const quantityPattern = new RegExp(`${quantityLabel}(${NUM})(万?)股`, 'g');
  for (const entry of active) {
    for (const raw of entry.value.matchAll(new RegExp(`${quantityLabel}([\\d.,]+)(万?)股`, 'g'))) {
      if (!new RegExp(`^${NUM}$`).test(raw[1])) issues.push(`${entry.plan}解除数量数字格式无效`);
    }
    for (const match of entry.value.matchAll(quantityPattern)) {
      const quantityShares = amount(match[1], match[2]);
      quantityClaims.push({ plan: entry.plan, quantityShares });
      const after = entry.value.slice(match.index + match[0].length, match.index + match[0].length + 95);
      const pct = new RegExp(`(?:约)?占(?:目前|公司|当前|的|股份总数|总股本|股本总额|股本|总额|目前公司){1,8}(?:的|比例为)?(${NUM})%`).exec(after);
      const holders = /(?:激励对象|股东)(?:人数)?(?:共计|共|为)(\d+)(?:名|人|户)/.exec(entry.value);
      if (quantityShares == null || quantityShares <= 0 || !pct || Number(pct[1]) <= 0 || Number(pct[1]) > 100) continue;
      const existing = releases.find(item => item.plan === entry.plan);
      if (existing) {
        if (existing.quantityShares !== quantityShares || Math.abs(existing.totalCapitalPct - Number(pct[1])) > .000001) issues.push(`${entry.plan}本次解除数量或占总股本比例冲突`);
        existing.records.push(record(entry)); if (holders) existing.holders = Number(holders[1]);
      } else releases.push({ plan: entry.plan, quantityShares, totalCapitalPct: Number(pct[1]), holders: holders ? Number(holders[1]) : null, records: [record(entry)] });
    }
  }
  for (const claim of quantityClaims) {
    const release = releases.find(item => item.plan === claim.plan);
    if (claim.quantityShares == null || release && release.quantityShares !== claim.quantityShares) issues.push(`${claim.plan}同一计划解除数量存在冲突或无效数值`);
  }
  const dateEntries = active.flatMap(entry => {
    const found = new RegExp(`本次(?:解除限售|解禁)(?:股份|股票)?(?:的)?上市流通(?:日期|时间|日)(?:为|:)?${DATE}`).exec(entry.value);
    return found ? [{ entry, date: isoDate(found.slice(1, 4)) }] : [];
  });
  const dates = [...new Set(dateEntries.map(item => item.date))];
  if (dates.length > 1 || dates.includes(null)) issues.push('本次上市流通日期存在冲突或无效日期');
  const listingDate = dates.length === 1 ? dates[0] : null;
  const unmet = /解除限售条件(?:尚未|未能|未|不(?:能|会)?)(?:全部)?(?:成就|满足)|(?:尚未|未能|未)(?:全部)?满足.{0,12}解除限售条件/;
  const achieved = active.filter(entry => /(?:本次|公司|预留授予|首批授予|限制性股票).{0,100}解除限售条件(?:已经|已)成就/.test(entry.value)
    && !unmet.test(entry.value) && !notActual(entry.value));
  if (active.some(entry => unmet.test(entry.value) && /本次|公司|预留授予|首批授予|限制性股票/.test(entry.value))) issues.push('本次解除限售条件尚未成就，不能按条件已满足解除门槛');
  if (declaredPlans.size > 1) for (const declaredPlan of declaredPlans) {
    if (!releases.some(item => item.plan === declaredPlan)) issues.push(`${declaredPlan}尚缺对应的解除数量与比例，不以其他计划补齐`);
    if (!achieved.some(entry => entry.plan === declaredPlan) && !dateEntries.some(item => item.entry.plan === declaredPlan)) issues.push(`${declaredPlan}尚缺对应的阶段事实，不以其他计划补齐`);
  }
  const stage = listingDate ? 'listing-scheduled' : achieved.length ? 'conditions-met' : 'unknown';
  const checks = [check('stage', '本次解除限售阶段', stage === 'unknown' ? null : stage, achieved.length ? achieved : dateEntries.map(item => item.entry)),
    check('releases', '分计划解除限售数量及占总股本比例', releases.length ? releases : null, [], releases.length ? '本次数量按激励计划分别保留，历史授予和历次解禁数量不混入' : ''),
    ...complianceChecks(active, 'unlock')];
  if (listingDate || /上市流通/.test(compact(document.title)) && stage !== 'conditions-met') checks.push(check('listingDate', '已披露的上市流通安排日期', listingDate, dateEntries.map(item => item.entry), listingDate ? '这是披露的流通安排日期，不表示已经实际卖出' : '上市流通安排尚缺唯一有效日期'));
  return { checks, issues, data: { stage, listingDate, basis: 'disclosed-release-schedule', releases: releases.map(item => ({ ...item, records: undefined })),
    immediatelyFreelySaleable: false, independentComplianceVerification: false }, evidence: releases.flatMap(item => item.records),
    pendingStage: stage === 'unknown', pendingReason: '本次解除限售尚未形成明确的条件成就或上市流通安排事实' };
}

function reviewCorporateAction(document, notice) {
  const title = compact(notice?.title);
  const type = /解禁|解除限售/.test(title) ? 'unlock' : /减持/.test(title) && /结果|进展|期限届满|实施情况|实施完成/.test(title) && !/不减持|终止|取消/.test(title) ? 'reduction' : null;
  if (!type) return null;
  const label = type === 'unlock' ? '解除限售阶段与规模' : '减持实施事实';
  const valid = document?.complete === true && Array.isArray(document.pageTexts) && document.pageTexts.length
    && document.pageTexts.every(page => page.complete === true && page.numericEligible === true && ['provider-text', 'pdf-text'].includes(page.method) && typeof page.text === 'string')
    && document.publishedAt === notice.date && compact(document.title) === title;
  const entries = valid ? sentences(document) : [];
  const parsed = valid ? type === 'unlock' ? unlockFacts(document, entries) : reductionFacts(document, entries)
    : { checks: [check('source', '可靠公告原文', null)], issues: [], data: { stage: 'unknown' }, evidence: [], pendingStage: true, pendingReason: '公告原文、日期或页面可靠性尚未核实' };
  const issue = valid ? scopedIssue(entries, document) : null;
  const missing = parsed.checks.filter(item => item.status !== 'verified');
  let eligibility;
  if (issue) { eligibility = issue; parsed.checks.push(check('eventRisk', '本次事项异常', false, issue.entries, issue.reason, 'conflict')); }
  else if (parsed.issues.length || parsed.pendingStage) eligibility = { status: 'pending', code: 'notice-event-pending', reason: parsed.issues.join('；') || parsed.pendingReason };
  else if (missing.length) eligibility = { status: 'pending', code: 'notice-facts-pending', reason: missing.map(item => item.reason).join('；') };
  else eligibility = { status: 'pass', code: 'notice-event-observed', reason: type === 'unlock' ? '本次解禁规模及阶段已有原文依据，作为股份供给变化观察；仅解除该类标题门槛，不表示股份已卖出或可以买入'
    : '原文明确本次减持已完成或期限届满，并披露合规及计划一致性；数量按股东和来源保留观察，仅解除该类标题门槛' };
  const warnings = eligibility.status === 'pass' ? [{ code: `${type}-supply-observation`, severity: 'warning', reason: eligibility.reason }] : [];
  // Fact records stay available even while timing, compliance or another field
  // is unresolved. Never erase a known sale quantity because its end date lags.
  const quantities = parsed.checks.find(item => ['transactions', 'releases'].includes(item.key));
  if (quantities) quantities.records = parsed.evidence;
  eligibility = { status: eligibility.status, code: eligibility.code, scope: 'sensitive-notice-title-only', reason: eligibility.reason };
  const finalMissing = parsed.checks.filter(item => item.status !== 'verified');
  return { version: 1, type, label, status: finalMissing.length || parsed.issues.length ? 'incomplete' : 'verified', checks: parsed.checks,
    data: { ...parsed.data, timingOrScopeIssues: parsed.issues, riskSignals: eligibility.status === 'blocked' ? [{ code: eligibility.code, reason: eligibility.reason }] : [] },
    verifiedFields: parsed.checks.filter(item => item.status === 'verified').map(item => item.key), missingFields: finalMissing.map(item => item.key),
    eligibility, warnings, reason: `完整原文已读取；${eligibility.reason}` };
}

module.exports = { reviewCorporateAction };
