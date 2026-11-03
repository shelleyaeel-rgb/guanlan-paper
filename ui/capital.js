'use strict';

let capitalPending = null, capitalStorageKey = '', capitalBusy = false, capitalStorageError = '';
function clearCapitalPending() {
  // A failed cleanup must not make a confirmed account operation look failed.
  // A stale saved request is reconciled against the ledger on the next load.
  try { localStorage.removeItem(capitalStorageKey); } catch {}
  capitalPending = null;
}
function saveCapitalPending() {
  localStorage.setItem(capitalStorageKey, JSON.stringify(capitalPending));
}
function renderCapital() {
  if (!state) return;
  const key = `guanlan:capital-pending:${state.dataPath}:${state.account.createdAt}`;
  if (capitalStorageKey !== key) {
    capitalStorageKey = key; capitalPending = null; capitalStorageError = '';
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && typeof saved.requestId === 'string' && Number.isFinite(saved.amount)
        && saved.accountCreatedAt === state.account.createdAt) capitalPending = saved;
    } catch { capitalStorageError = '无法保存追加操作的重试信息，请恢复本地存储后重新打开应用。'; }
    $('capital-amount').value = capitalPending ? capitalPending.amount : '';
    $('capital-status').textContent = '';
  }
  const flows = state.account.capitalFlows || [];
  const completed = capitalPending && flows.find(flow => flow.requestId === capitalPending.requestId);
  if (completed && !capitalBusy) {
    clearCapitalPending(); $('capital-amount').value = '';
    $('capital-status').textContent = `已核对：虚拟本金 ¥ ${cash(completed.amount)} 已入账，历史记录已保留。`;
  }
  $('capital-summary').textContent = `初始本金 ¥ ${cash(state.account.initialCash)} · 累计投入 ¥ ${cash(state.stats.cumulativeCapital ?? state.account.initialCash)}`;
  setHtml('capital-history', flows.length ? table(['时间', '追加金额（元）'], flows.slice(-20).reverse().map(flow => [esc(timeText(flow.time)), cash(flow.amount)])) : '<p class="tiny">暂无追加记录。</p>');
  $('capital-amount').readOnly = capitalBusy || !!capitalPending && !capitalPending.rejected;
  $('capital-submit').disabled = capitalBusy || state.accountPaused || !!capitalStorageError;
  $('capital-submit').textContent = capitalBusy ? '正在处理…' : capitalPending ? '重试本次追加' : '追加虚拟本金';
  if (state.accountPaused) $('capital-status').textContent = state.warning || '账户已暂停，不能追加本金。';
  else if (capitalStorageError) $('capital-status').textContent = capitalStorageError;
  else if (capitalPending && !$('capital-status').textContent) $('capital-status').textContent = '上次追加尚未确认；重试会核对同一笔操作，不会重复入账。';
}

$('capital-amount').addEventListener('input', () => {
  // Only an explicit rejection proves the previous attempt did not commit.
  // An interrupted response keeps the amount locked until ledger confirmation.
  if (capitalPending?.rejected && Number($('capital-amount').value) !== capitalPending.amount) {
    clearCapitalPending(); $('capital-status').textContent = ''; renderCapital();
  }
});
$('capital-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    if (capitalBusy || state?.accountPaused) return;
    const amount = Number($('capital-amount').value);
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 100000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001)
      throw Error('追加本金须为 0.01 至 100,000,000 元，最多两位小数');
    capitalBusy = true; renderCapital();
    let submitted = null, failure = null;
    try {
      if (!capitalPending) {
        const accountCreatedAt = state.account.createdAt;
        if (!await confirmDialog('确认追加虚拟本金', `向当前模拟账户追加 <b>¥ ${num(amount)}</b>。<p>资金先计入未分配资金，之后可划拨给策略。初始本金、持仓、委托和交易历史全部保留；追加金额不计入盈利。</p>`)) return;
        if (state.account.createdAt !== accountCreatedAt) throw Error('模拟账户已变更，请重新确认追加本金');
        capitalPending = { amount, requestId: crypto.randomUUID(), accountCreatedAt };
      }
      // Persist the same identity before every send, including after a rejected
      // attempt, so a reload or lost reply cannot turn a retry into a second flow.
      capitalPending.rejected = false;
      try { saveCapitalPending(); }
      catch { capitalStorageError = '无法保存追加操作的重试信息，本次未提交。请恢复本地存储后重新打开应用。'; throw Error(capitalStorageError); }
      $('capital-status').textContent = '正在核对并保存本次追加…';
      submitted = { ...capitalPending };
      let response;
      try { response = await window.guanlan.call('capital:add', submitted); }
      catch { throw Error('暂未收到追加结果，请重试核对'); }
      if (!response.ok) {
        if (capitalPending?.requestId === submitted.requestId) {
          capitalPending.rejected = true;
          try { saveCapitalPending(); } catch {}
        }
        throw Error(response.error);
      }
      clearCapitalPending(); $('capital-amount').value = '';
      $('capital-status').textContent = `虚拟本金 ¥ ${cash(response.data.amount)} 已入账，历史记录已保留。`;
      toast(`已追加虚拟本金 ¥ ${cash(response.data.amount)}`);
    } catch (error) {
      failure = error;
      $('capital-status').textContent = `${error.message}${capitalPending && !capitalPending.rejected ? '；重试会核对同一笔操作，不会重复入账。' : ''}`;
    } finally {
      capitalBusy = false;
      // A reply may be lost after the ledger commits; reconciliation also
      // clears that pending request without sending another account mutation.
      try { renderState(await api('state')); } catch {}
      renderCapital();
    }
    // If a state update confirms the committed flow despite a lost reply,
    // report that result rather than presenting the transport failure as loss.
    const confirmed = submitted && state.account.createdAt === submitted.accountCreatedAt
      && state.account.capitalFlows?.some(flow => flow.requestId === submitted.requestId);
    if (failure && !confirmed) throw failure;
  });
});
