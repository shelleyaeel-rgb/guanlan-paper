'use strict';
// These rules classify a disclosed event, not the company's investment value.
// A pass only removes the keyword gate for this document. Unknown fields stay unknown.
const { actualAmendment } = require('./company-notice-facts.cjs');
const compact = value => String(value || '').normalize('NFKC').replace(/\s+/g, '');
const entries = document => document.pageTexts.flatMap(page => page.text.split(/[。；;]/)
  .map(text => ({ text: text.trim(), value: compact(text), page: page.page, method: page.method })).filter(item => item.value));
const record = entry => ({ page: entry.page, method: entry.method, quote: entry.text });
function field(all, key, label, pattern, value = match => match[0], missingReason, accept = () => true) {
  const found = all.flatMap(entry => { const match = pattern.exec(entry.value), parsed = match && accept(entry, match) ? value(match) : null;
    return parsed == null ? [] : [{ entry, value: parsed }]; });
  return { key, label, status: found.length ? 'verified' : 'missing', value: found.length ? found[0].value : null,
    records: found.map(item => record(item.entry)), reason: found.length ? `${label}已按原文核实` : missingReason || `${label}尚未在原文可靠识别` };
}
function negativeBefore(text, offset) {
  const before = text.slice(0, offset).split(/但是|但|然而|不过|却|(?:同时|且|并|另外)(?=(?:已经|已)?(?:发生|出现|造成|存在|被))/).at(-1);
  if (/无法确认|不能确认|不能排除|尚不能|尚未确认/.test(before)) return false;
  return /(?:不存在|未发生(?:过)?|未发现|未造成|未产生|不涉及|没有|并无|不会|不构成|未对)[^。；]{0,80}$/.test(before)
    || /(?:无|未)(?:任何|其他|新的|重大)?$/.test(before);
}
function conditional(text) {
  return /(?:如若|如果|若|可能|将来|未来|一旦|能否|尚不能|尚无法|不确定)/.test(text)
    && !/(?:已经|已发生|已出现|现已|实际发生)/.test(text);
}
function adverseFindings(all) {
  const pattern = /债务违约|流动性危机|重大损失|重大不利影响|重大安全性问题|严重安全性问题|(?:临床试验|研究)(?:已|已经|被)?(?:失败|暂停|终止)|(?:未达到|未达成)[^，。；]{0,12}(?:主要|研究)终点|(?:主要|研究)终点[^，。；]{0,8}(?:未达到|未达成)|被立案调查|被行政处罚|违反[^，。；]{0,8}(?:减持承诺|减持计划)/g;
  return all.flatMap(entry => entry.value.split(/[，,]/).flatMap(clause => [...clause.matchAll(pattern)]
    .filter(match => !negativeBefore(clause, match.index) && !conditional(clause)
      && !/(?:风险|可能性|不得|禁止|若发生|如发生)/.test(clause.slice(Math.max(0, match.index - 8), match.index + match[0].length + 4)))
    .map(match => ({ topic: match[0], record: record(entry) }))));
}
function finish(document, type, label, checks, options = {}) {
  const missing = checks.filter(item => item.status !== 'verified' && item.required !== false);
  const all = entries(document), adverse = adverseFindings(options.normative
    ? all.filter(entry => /(?:本公司|公司)(?:已|已经|本次|现已)/.test(entry.value)) : all);
  let status = options.status || (missing.length ? 'pending' : 'pass');
  let code = options.code || (missing.length ? 'notice-facts-pending' : 'notice-event-cleared');
  let reason = options.reason || (missing.length ? `待核实：${missing.map(item => item.label).join('、')}` : '本篇事件事实已核实，解除该敏感标题门槛');
  if (actualAmendment(document)) { status = 'pending'; code = 'notice-event-pending'; reason = '原文涉及实际公告修订，须核实生效版本及替代字段'; }
  if (adverse.length) { status = 'blocked'; code = 'notice-event-blocked'; reason = `原文披露实质不利事项：${[...new Set(adverse.map(item => item.topic))].join('、')}，暂停新增候选`; }
  const warnings = options.warnings || [];
  return { version: 2, type, label, status: missing.length ? 'incomplete' : 'verified', checks,
    verifiedFields: checks.filter(item => item.status === 'verified').map(item => item.key), missingFields: missing.map(item => item.key),
    data: { basis: 'issuer-disclosed-event', ...options.data, adverseFindings: adverse }, warnings,
    eligibility: { status, code, scope: 'sensitive-notice-title-only', reason },
    reason: `完整原文已读取；${label}：${reason}。仅核验本篇披露范围，不代表买入许可` };
}
const warning = (code, reason) => ({ code, severity: 'warning', reason });
const affirmative = (entry, match) => !/尚未|并未|没有|未曾|未能|未获|未批准|未同意|未审议|不能确认|无法确认|尚待|拟申请|预计|若|如果|并非/.test(
  entry.value.slice(Math.max(0, match.index - 15), match.index + match[0].length));
function reviewClinical(document, all) {
  const title = compact(document.title);
  const target = /[A-Z]{1,8}-?\d+[A-Z0-9-]*/.exec(title)?.[0];
  const product = field(all, 'product', '药物或试验对象', /(?:产品名称|药品名称)[:：]?([^，。；]{2,70}?)(?=申请事项|注册分类|受理号|剂型|适应症|IND编号|$)/,
    match => match[1]);
  if (product.status !== 'verified') {
    const named = field(all, 'product', '药物或试验对象', /(?:[A-Z]{1,8}[0-9][A-Z0-9-]*)(?:注射液|片|胶囊)?/);
    if (named.status === 'verified') Object.assign(product, named);
  }
  if (target && !String(product.value || '').includes(target)) Object.assign(product,
    { status: 'missing', value: null, reason: '正文药物名称尚未与标题的本次药物对应' });
  const approved = /批准/.test(title), accepted = /受理/.test(title) && !approved;
  const trialResult = /顶线|终点|试验.*结果/.test(title);
  const trialIds = target ? [...new Set(all.filter(entry => entry.value.includes(target)).flatMap(entry =>
    [...entry.value.matchAll(/临床试验\(([A-Z][A-Z0-9-]+)\)/g)].map(match => match[1])))] : [];
  const subjectEntries = all.filter(entry => !/另一(?:产品|药物|试验)|其他(?:产品|药物)|竞品/.test(entry.value)
    && (target && entry.value.includes(target) || trialIds.length === 1 && entry.value.includes(trialIds[0])
      || /本品|本次(?:临床)?试验|本试验/.test(entry.value)));
  let phase;
  if (approved) phase = field(subjectEntries, 'phase', '临床申请批准事实', /(?:同意(?:本品)?(?:在[^，。；]{0,30})?开展[^，。；]{0,70}临床试验|(?:临床试验申请|本品)[^，。；]{0,12}(?:获得|获|已经|已)(?:得)?批准)/, () => 'clinical-trial-approved', undefined, affirmative);
  else if (accepted) phase = field(subjectEntries, 'phase', '临床申请受理事实', /(?:收到[^。；]{0,110}(?:FDA|食品药品监督管理局)[^。；]{0,110}临床试验申请受理通知|(?:IND|临床试验)申请获得(?:FDA)?受理)/, () => 'application-accepted', undefined, affirmative);
  else phase = field(subjectEntries, 'phase', '临床试验阶段', /(?:I{1,3}|Ⅰ|Ⅱ|Ⅲ|[一二三])期临床试验/, match => match[0]);
  const checks = [product, phase];
  if (trialResult) {
    checks.push(field(subjectEntries, 'endpoint', '主要终点结果', /(?<!未)(?<!不)(?:达到|达成)(?:预设的?)?主要终点/, () => 'achieved', undefined, affirmative));
    checks.push(field(subjectEntries, 'sampleSize', '试验入组人数', /(?:共)?入组(\d+)例/, match => Number(match[1]) > 0 ? Number(match[1]) : null));
    checks.push(field(subjectEntries, 'safety', '本试验安全性披露', /(?:安全性[、,]?耐受性良好|未发现新增安全性信号|安全性良好)/,
      match => match[0], undefined, affirmative));
  }
  if (trialResult && (trialIds.length > 1 || subjectEntries.some(entry => /(?:本次|本试验|试验结果)[^。；]{0,15}(?:尚未形成|尚未获得|尚未揭盲|尚无结果)/.test(entry.value)))) {
    return finish(document, 'clinical', '临床试验结果', checks, { status: 'pending', code: 'notice-event-pending', reason: '本次试验结果尚未形成，或多个试验的事实尚不能唯一对应' });
  }
  if (!approved && !accepted && !trialResult) return finish(document, 'clinical', '临床进展', checks,
    { status: 'pending', code: 'notice-event-pending', reason: '临床进展尚未归入可核验的受理、批准或结果阶段' });
  return finish(document, 'clinical', accepted ? '临床申请受理' : approved ? '临床试验批准' : '临床试验结果', checks,
    { data: { stage: phase.value }, warnings: [warning('clinical-stage-observation', accepted
      ? '本次仅受理申请，尚非获准开展试验或药品获批上市；审查期及后续研发结果仍需跟踪'
      : approved ? '本次批准开展临床试验，尚非药品获批上市；后续试验、审批及商业化仍有不确定性'
        : '本次为公司披露的试验结果；顶线数据不是最终报告，不进行跨试验疗效比较，也不推断获批或商业化成功')] });
}
function reviewTermination(document, all) {
  const title = compact(document.title);
  const decision = field(all, 'decision', '本次终止决定', /(?:审议通过[^。；]{0,130}终止|(?:同意|决定|决议|经各方充分协商)[^。；]{0,70}终止|已签署[^。；]{0,50}终止协议)/,
    match => match[0], undefined, affirmative);
  if (/购买资产|收购|重组/.test(title)) return finish(document, 'asset-transaction-termination', '资产交易终止', [decision],
    { status: 'pending', code: 'notice-event-pending', reason: '终止资产收购或重组须另行核验已付对价、退款、解约责任及实际影响，不能按普通融资计划终止放行' });
  if (/内部股权结构调整/.test(title)) {
    const untransferred = field(all, 'untransferred', '原股权转让未实施', /(?:股份尚未办理过户登记|股权转让不再实施|原股权结构调整事项不再实施)/);
    const restored = field(all, 'restored', '原控制结构及一致行动关系', /(?:持股比例恢复至原股权转让协议签署前状态|控股股东及实际控制人未发生变化)/);
    const agreement = field(all, 'agreement', '一致行动协议重新签署', /(?:更新签署的《一致行动协议》主要内容|已签署新的《一致行动协议》)/);
    return finish(document, 'control-arrangement', '内部股权安排终止', [decision, untransferred, restored, agreement],
      { warnings: [warning('control-arrangement-observation', '仅核实本次未实施的内部调整及一致行动安排；后续控制权变化另行核验')] });
  }
  const impact = field(all, 'impact', '本次终止的经营影响声明', /(?:本次|此次)(?:终止|注销)[^。；]{0,220}(?:不会[^。；]{0,90}(?:产生|造成)(?:重大)?(?:不利)?影响|不会对[^。；]{0,100}造成重大影响)/);
  if (/发行.*(?:股|股票)|H股/.test(title)) {
    const operations = field(all, 'operations', '当前经营状态', /(?:公司目前生产经营活动均正常进行|目前公司经营状况正常|公司生产经营正常)/);
    return finish(document, 'financing-termination', '融资计划终止', [decision, operations, impact],
      { warnings: [warning('financing-termination-observation', '终止的是本次融资计划，不等同于现有股票终止上市；未来融资需求及资金状况仍需结合财务指标判断')] });
  }
  const funding = field(all, 'funded', '本次投资已出资状态', /(?:本次投资|共同投资[^。；]{0,60}|公司)[^。；]{0,25}尚未出资/, () => 0,
    '未能确认未出资；已实施投资须继续核验账面价值、清算回收和实际损益');
  return finish(document, 'investment-termination', '投资项目终止', [decision, funding, impact],
    { warnings: [warning('investment-termination-observation', '按本篇披露核验未出资投资计划终止；不将计划投资额计为已发生损失或已实现回收')] });
}
function reviewLitigation(document, all) {
  const role = field(all, 'role', '公司诉讼身份', /(?:公司(?:所处的诉讼地位|为|作为)[:：]?(原告|被告)|(?:原告|被告)[:：][^。；]{0,80}(?:本公司|股份有限公司))/, match => match[1] || match[0]);
  role.required = false;
  const stage = field(all, 'stage', '诉讼阶段', /(?:一审尚未开庭审理|一审判决(?:阶段)?|一审审理中|执行(?:进展|阶段)|已结案|已经结案|调解结案|二审判决)/);
  const obligation = field(all, 'obligation', '本事件相关义务履行', /(?:本次(?:诉讼|仲裁)(?:已|已经)结案[,，](?:本公司|公司)?(?:相关义务|判决义务|和解义务|裁决义务|全部义务)(?:均)?(?:已|已经)(?:全部)?履行完毕)/);
  const impact = field(all, 'impact', '本事件实际影响', /^本次(?:诉讼|仲裁)(?:事项)?[,，]?(?:对(?:本公司|公司)(?:的)?(?:生产经营|经营|财务状况|经营及财务状况)(?:未造成|未产生|无)重大不利影响|未对(?:本公司|公司)(?:的)?(?:生产经营|经营|财务状况)(?:造成|产生)重大不利影响)$/);
  const checks = [stage, role, obligation, impact];
  // Negative statements about other cases or losses must not manufacture an open event.
  const open = all.some(entry => entry.value.split(/[，,]/).some(clause => {
    if (/^(?:公司及子公司|本公司|公司)?不存在(?:应披露而未披露的)?其他(?:诉讼|仲裁)/.test(clause)) return false;
    return /尚未(?:生效|开庭|结案)|尚待|仍需|仍存在|未结案|未履行|义务未完成|未执行完毕|无法判断|无法确定|(?:影响|结果).{0,8}(?:尚不确定|不确定性)|其他.{0,12}(?:诉讼|仲裁|争议)/.test(clause);
  }));
  const completed = obligation.records.some(item => /^本次/.test(compact(item.quote)));
  const negativeImpact = all.some(entry => /不利|损失|亏损|违约|处罚|立案/.test(entry.value)
    && !impact.records.some(item => item.quote === entry.text)
    && !/^(?:本次(?:诉讼|仲裁)|本公司|公司)(?:不存在不确定性|未(?:造成|产生)(?:任何|重大)?损失|未受处罚)$/.test(entry.value));
  const pass = completed && impact.status === 'verified' && !open && !negativeImpact;
  return finish(document, 'litigation', '诉讼及仲裁事件', checks, { status: pass ? 'pass' : 'pending',
    code: pass ? 'notice-event-cleared' : 'notice-event-pending',
    reason: pass ? '本事件已结案、公司相关义务已履行且实际影响明确'
      : '原文已读取；尚需结合诉讼身份、审理或执行阶段、涉案金额及已计提金额核实剩余影响，未把追偿进展当作新增赔偿损失',
    data: { stage: stage.value, role: role.value } });
}
function reviewEventNotice(document, notice) {
  const title = compact(notice.title), all = entries(document);
  if (/重大事项内部报告制度》?(?:\([^)]*\))?$/.test(title)) {
    const checks = [field(all, 'nature', '制度文件性质', /制定本制度|本制度由董事会负责解释/),
      field(all, 'scope', '内部报告程序', /重大事项(?:内部报告|报告人)|报告义务和报告程序/)];
    return finish(document, 'governance-policy', '内部管理制度', checks,
      { normative: true, reason: checks.every(item => item.status === 'verified') ? '原文为内部报告制度，其列举的风险情形不是已发生事件' : undefined });
  }
  if (/不减持.*承诺/.test(title)) {
    const commitment = field(all, 'commitment', '不减持承诺范围', /(?:不以任何方式减持|不减持(?:所持有的?|本公司|公司)股份)/);
    const term = field(all, 'term', '承诺有效期间', /(?:自)?(20\d{2}年\d{1,2}月\d{1,2}日)(?:起[^。；]{0,40})?至(20\d{2}年\d{1,2}月\d{1,2}日)/, match => {
      const parse = text => { const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(text);
        const iso = `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
        return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : null; };
      const start = parse(match[1]), end = parse(match[2]); return start && end && start <= end ? { start, end } : null;
    });
    const holder = field(all, 'holders', '承诺主体', /(?:控股股东|实际控制人)[^。；]{0,160}承诺[:：]/);
    return finish(document, 'non-reduction-commitment', '不减持承诺', [commitment, term, holder],
      { warnings: [warning('commitment-observation', '本次是不减持承诺，不是已经发生减持；承诺履行仍需跟踪')] });
  }
  if (/临床|试验|研究终点|主要终点/.test(title) && !/诉讼|重组/.test(title)) return reviewClinical(document, all);
  if (/诉讼|仲裁/.test(title) && !/减持|资产|临床|处罚|立案|退市/.test(title)) return reviewLitigation(document, all);
  if (/股票交易.*风险提示|异常波动/.test(title)) {
    const signal = field(all, 'tradingRisk', '公司披露的异常交易风险', /(?:非理性炒作|市场炒作风险|股价[^。；]{0,50}(?:业绩背离|获利调整风险)|短期(?:涨幅|上涨)[^。；]{0,45}(?:回落|回调|下跌)风险|股价持续上涨积累了较多的获利调整风险)/);
    const movement = field(all, 'movement', '披露的涨幅或换手数据', /(?:涨幅|上涨|换手率|偏离值)[^。；]{0,22}?([+-]?\d+(?:\.\d+)?)%/, match => ({ disclosed: match[0], valuePct: Number(match[1]) }));
    movement.required = false;
    return finish(document, 'trading-volatility', '异常交易风险', [signal, movement], { status: signal.status === 'verified' ? 'blocked' : 'pending',
      code: signal.status === 'verified' ? 'notice-event-blocked' : 'notice-event-pending',
      reason: signal.status === 'verified' ? '公司原文明示异常交易及调整风险，按公告风险规则暂停新增候选，后续结合新鲜行情和后续公告复核'
        : '已识别交易异动公告，但尚未核实可解除门槛的具体波动及经营影响；无未披露重大事项不等于无交易风险' });
  }
  if (/终止/.test(title) && /投资|发行|内部股权结构调整/.test(title) && !/终止上市|退市|诉讼/.test(title)) return reviewTermination(document, all);
  if (/重大资产|重大事项|购买资产/.test(title)) {
    const deal = field(all, 'transaction', '资产交易及审批进度', /(?:拟以发行股份及支付现金方式购买[^。；]{0,120}|本次交易[^。；]{0,80}(?:尚未完成|尚需履行|尚未最终确定))/);
    return finish(document, 'asset-transaction', '资产交易进展', [deal], { status: 'pending', code: 'notice-event-pending',
      reason: '资产交易须核实对价、审批、资金安排及公司影响；引用重大资产重组法规不等于本次交易已构成重大资产重组' });
  }
  return null;
}
module.exports = { reviewEventNotice, adverseFindings };
