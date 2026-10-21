const clean = text => String(text || '').normalize('NFKC').replace(/[\t \u3000]+/g, ' ').trim();
const compact = text => clean(text).replace(/\s+/g, '');
const SECTION = /^(?:第[一二三四五六七八九十百0-9]+[章节]|[一二三四五六七八九十]+[、.]|\([一二三四五六七八九十0-9]+\)|\d+[、.](?!\d))/;
const checkboxGlyphs = /[□☐√☑☒✓✔\uE000-\uF8FF]/;
const checkboxTopic = text => /(?:重大)?会计差错更正|重大会计更正|重大财务更正|债务逾期|逾期债务|债务违约|已逾期未偿还的短期借款|与持续经营相关的重大不确定性/.test(compact(text));
const PRODUCT_WORDS = ['数控龙门加工中心', '数控卧式加工中心', '数控立式加工中心', '氧化铝', '铝用阳极炭素', '石墨化阴极',
  '重熔用铝锭', '重熔用精铝锭', '变形铝及铝合金圆铸锭', '变形铝及铝合金扁铸锭', '铸造铝合金锭', '电工圆铝杆', '铝及铝合金焊材',
  '聚乙烯', '聚丙烯', '氯化钾', '碳酸锂', '光学树脂镜片'];
function knownProductContinuation(left, right) {
  if (!/(?:主要|核心|主营)产品(?:及服务)?(?:包括|为|是|有)[^。；;！？!?]*$/.test(left)) return false;
  return PRODUCT_WORDS.some(word => [...word].slice(1).some((_, index) => {
    const split = index + 1;
    return left.endsWith(word.slice(0, split)) && right.startsWith(word.slice(split))
      && /^(?:[、,，。；;！？!?]|等(?:[。；;！？!?]|$)|$)/.test(right.slice(word.length - split));
  }));
}

function checkboxSelection(text) {
  const value = compact(text);
  if (!checkboxGlyphs.test(value)) return null;
  // Never interpret an unselected "不适用" as the answer. Unknown private-use
  // glyphs must first be verified by the PDF parser's font mapping.
  if (/[\uE000-\uF8FF]/.test(value)) return 'unknown';
  const choices = [...value.matchAll(/([□☐√☑☒✓✔])(不适用|适用)/g)];
  if (choices.length !== 2 || new Set(choices.map(match => match[2])).size !== 2) return 'unknown';
  if (/适用/.test(value.replace(/[□☐√☑☒✓✔](?:不适用|适用)/g, ''))) return 'unknown';
  const marked = choices.filter(match => !/[□☐]/.test(match[1]));
  return marked.length === 1 ? marked[0][2] === '不适用' ? 'notApplicable' : 'applicable' : 'unknown';
}

function boundary(text) {
  const value = compact(text);
  return !value || SECTION.test(value) || /^[-—]?\d+[-—]?$/.test(value)
    || /^(?:单位[:：]|项目(?:名称)?$|其他说明[:：]|注[:：])/.test(value)
    || checkboxGlyphs.test(value) || /\.{5,}/.test(value)
    || (text.match(/(?:^|\s)[-−]?\d[\d,.%]*/g) || []).length >= 3
      && value.replace(/[\d,.%\-−]/g, '').length < value.length * 0.45;
}

function continuationKind(text, next, options) {
  const value = compact(text);
  if (/^我们(?:认为|审计了)/.test(value)) return 'audit';
  if ((/^(?:本公司|公司)/.test(value) || options.issuerName && value.startsWith(options.issuerName))
    && /(?:生产|开发|制造|销售|生产企)$/.test(value)
    && /^(?:集团|企业|业|公司)之一[,，](?:其)?主要业务(?:是|为|包括)/.test(compact(next))) return 'issuerBusiness';
  if (/(?:所属行业|所处行业|行业分类|公司业务属于|本公司业务属于)/.test(value)) return 'industry';
  if (/(?:根据|据|援引|引用|按照).{0,100}(?:协会|研究院|研究所|咨询|委员会|机构|统计局|[A-Z])/.test(value)) return 'citation';
  if (/(?:主要|核心|主营)产品(?:及服务)?(?:包括|为|是|有)/.test(value)
    || /(?:公司|其)?主要业务(?:是|为|包括)|公司主营的贸易品种包括/.test(value)) return 'products';
  if (/(?:产品|业务|销量|销售量|订单量|订单金额|需求量|所属行业|所处行业|行业分类)/.test(value)
    && !/^(?:项目|产品名称|产品类别|主营业务分产品|分产品|分行业)/.test(value)) return 'fact';
  return null;
}

function mayContinue(current, next, kind) {
  if (/[。；;！？!?]\s*$/.test(current) || boundary(next)) return false;
  const left = compact(current), right = compact(next);
  // Lists/independent issuer statements are boundaries, even when the PDF
  // omitted punctuation. Audited sentences and citations have their own scope.
  if (/^(?:本公司|公司|报告期内|本报告期|我们|主要产品|核心产品|所属行业|主营业务)/.test(right)) {
    return kind === 'citation' && /[,，:]$/.test(left) && /^(?:本公司|公司)(?:在|的)/.test(right);
  }
  if (kind === 'audit') return !/^(?:此外|同时|其中|我们)/.test(right);
  if (kind === 'issuerBusiness') return /^(?:集团|企业|业|公司)之一[,，](?:其)?主要业务(?:是|为|包括)/.test(right);
  if (kind === 'citation') return !/^(?:此外|同时|另外)/.test(right);
  if (kind === 'industry') return /[,，、]$/.test(left) || /\([A-R][0-9]{0,4}$/.test(left) || /(?:计|计算|通|制|制造|技术服)$/.test(left)
    && /^(?:算机|机|信|造业|业|务)/.test(right);
  if (kind === 'products') return /[,，、及和]$/.test(left) && !/^(?:而|但|然而|竞争对手|其他公司)/.test(right)
    // Restore only known machine-tool names split inside an explicit product
    // list. The following delimiter must complete the name, not start a claim.
    || knownProductContinuation(left, right);
  // Recover only an unfinished, recognisable word/unit or the immediately
  // following growth clause. Line length alone is not proof of continuation.
  return /[,，]$/.test(left) && /^(?:同比|较上年同期|比上年同期|比去年)/.test(right)
    || /(?:营业|销售|业务|总)?收$/.test(left) && /^入/.test(right)
    || /(?:销|销售)$/.test(left) && /^(?:量|售量)/.test(right)
    || /(?:制|制造)$/.test(left) && /^(?:造业|业)/.test(right)
    || /(?:同比|较上年同期|比上年同期)$/.test(left) && /^(?:增长|增加|上升|上涨|下降|减少|下滑)/.test(right)
    || /(?:增长|增加|上升|上涨|下降|减少|下滑)$/.test(left) && /^\d/.test(right);
}

function paragraphEntries(page, options = {}) {
  const provenance = { page: page.page ?? null, method: page.method || 'provider-text', confidence: page.confidence ?? null,
    numericEligible: page.numericEligible, textHash: page.textHash || null,
    trusted: options.trusted ?? (page.method !== 'ocr' && page.numericEligible === true), nonContent: options.nonContent === true };
  const lines = String(page.text).split(/\r?\n/).map((text, index) => ({ text: clean(text), line: index + 1 }));
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].text) continue;
    const first = i, parts = [lines[i].text];
    if (provenance.trusted) {
      // Only the immediately adjacent, self-contained option row can answer a
      // known topic. Never search through another heading or over a page break.
      const next = lines[i + 1]?.text;
      if (checkboxTopic(parts[0]) && next && /^[□☐√☑☒✓✔\uE000-\uF8FF适用不\s]+$/.test(next)
        && !checkboxGlyphs.test(parts[0])) parts.push(lines[++i].text);
      else {
        const kind = continuationKind(parts[0], next, options);
        while (kind && i + 1 < lines.length && i - first < 7 && parts.join('').length < 1200
          && mayContinue(parts.join('\n'), lines[i + 1].text, kind)) parts.push(lines[++i].text);
      }
    }
    // Punctuation ends the claim; retained newlines are part of its exact quote.
    const joined = parts.join('\n');
    for (const match of joined.matchAll(/[^。；;]+/g)) {
      const text = clean(match[0]); if (!text) continue;
      const start = match.index + match[0].length - match[0].trimStart().length;
      const end = match.index + match[0].trimEnd().length;
      const lineStart = lines[first].line + (joined.slice(0, start).match(/\n/g) || []).length;
      const lineEnd = lines[first].line + (joined.slice(0, end).match(/\n/g) || []).length;
      output.push({ ...provenance, text, lineStart, lineEnd,
        checkbox: checkboxSelection(text), sectionHeading: SECTION.test(compact(text)) });
    }
  }
  return output;
}

module.exports = { paragraphEntries, checkboxSelection };
