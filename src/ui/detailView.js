import { replayScheme, deriveTank } from '../domain/replay.js';
import {
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
  DomainError,
  EVENT_TYPES,
} from '../domain/events.js';
import { validateRound } from '../domain/validate.js';
import { reviewDrift, validateDriftParams } from '../domain/drift.js';
import { ConflictError } from '../store/recordStore.js';
import { esc, fmtTs, toLocalInputValue } from './dom.js';

/**
 * 方案详情页：每槽本轮趋势、下一步资格、修订号、自首项记录重放的不可改写过程。
 * 所有变更操作均以渲染时所见的修订号提交；发生冲突时拒绝写入并展示最新状态。
 */
export function renderDetail(ctx, schemeId, options = {}) {
  const { store, root } = ctx;
  const record = store.load(schemeId);
  if (!record) {
    root.innerHTML = `<section class="panel"><p class="empty">未找到该方案。<a href="#/">返回方案列表</a></p></section>`;
    return;
  }
  const state = replayScheme(record.events);
  const tanks = state.tanks.map(deriveTank);

  root.innerHTML = `
    <section class="panel scheme-head">
      <a class="back" href="#/">← 返回方案列表</a>
      <div class="scheme-title">
        <h2>${esc(state.name)}</h2>
        <span class="rev" title="每次写入修订号 +1；操作须以所见修订号提交">修订号 r${record.revision}</span>
      </div>
      <p class="muted">共 ${record.events.length} 条记录 · 当前状态自首项记录重放生成 · 记录不可改写</p>
      ${options.banner ? `<div class="banner warn">${esc(options.banner)}</div>` : ''}
    </section>
    ${tanks.map((tank) => tankCardHtml(tank)).join('')}
    <section class="panel">
      <h3>过程记录（自首项记录重放 · 不可改写）</h3>
      <ol class="log">${record.events.map((ev) => `<li>${renderEvent(ev, state)}</li>`).join('')}</ol>
    </section>`;

  bindDetail(ctx, record, tanks);
}

function tankCardHtml(tank) {
  return `
  <section class="panel tank" data-tank-id="${tank.id}">
    <div class="tank-head">
      <h3>${esc(tank.name)}</h3>
      <p class="muted">目标上限 ${tank.limit} µS/cm · 需连续 ${tank.requiredRounds} 轮严格下降且末值达标 · 已换液 ${tank.liquidChanges} 次 · 当前周期已完成 ${tank.periodRounds.length} 轮</p>
    </div>
    <table class="grid">
      <thead><tr><th>器物</th><th>状态</th><th>本轮趋势</th><th>连续达标</th><th>末值</th><th>资格</th><th>操作</th></tr></thead>
      <tbody>${tank.artifacts.map((a) => artifactRowHtml(tank, a)).join('')}</tbody>
    </table>
    ${tank.allRemoved
      ? '<p class="done">✅ 全部器物已出槽，本槽监测完成。</p>'
      : `${nextStepHtml(tank)}${roundFormHtml(tank)}${driftReviewHtml(tank)}`}
  </section>`;
}

function artifactRowHtml(tank, a) {
  const trend = a.periodReadings.length > 0
    ? a.periodReadings.map((r) => r.value).join(' → ')
    : '—';
  const lastOk = a.lastValue != null && a.lastValue <= tank.limit;
  return `<tr>
    <td>${esc(a.name)}</td>
    <td>${a.status === 'soaking' ? '浸泡中' : '已出槽'}</td>
    <td class="trend">${trend}</td>
    <td><span class="badge ${a.eligible ? 'ok' : 'pending'}">${a.streak}/${tank.requiredRounds}</span></td>
    <td>${a.lastValue == null
      ? '—'
      : `<span class="${lastOk ? 'ok-text' : 'bad-text'}">${a.lastValue}</span> <span class="muted">/ ≤${tank.limit}</span>`}</td>
    <td>${a.status !== 'soaking'
      ? '—'
      : a.eligible
        ? '<span class="badge ok">达标</span>'
        : '<span class="badge pending">未达标</span>'}</td>
    <td>${a.status === 'soaking'
      ? `<button data-action="remove" data-tank="${tank.id}" data-artifact="${a.id}" ${a.eligible ? '' : 'disabled title="未连续达标，不能出槽"'}>出槽</button>`
      : '—'}</td>
  </tr>`;
}

function nextStepHtml(tank) {
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  const blockers = soaking
    .filter((a) => !a.eligible)
    .map((a) => {
      const parts = [`连续 ${a.streak}/${tank.requiredRounds} 轮`];
      if (a.lastValue == null) parts.push('尚无读数');
      else if (a.lastValue > tank.limit) parts.push(`末值 ${a.lastValue} 高于上限`);
      return `「${esc(a.name)}」${parts.join('、')}`;
    })
    .join('；');
  const removable = soaking.filter((a) => a.eligible).map((a) => `「${esc(a.name)}」`).join('、');
  return `<div class="next-step">
    <h4>下一步资格</h4>
    <ul>
      <li>提交读数：可提交本周期第 ${tank.nextRoundInPeriod} 轮，须恰含 ${tank.soakingCount} 件在泡器物各一次整数读数，且采样时间严格递增。</li>
      <li>换液：${tank.allSoakingEligible
        ? '✅ 全部在泡器物已共同达标，可执行换液（换液后本槽轮次清零）。'
        : `❌ 暂不可换液 —— ${blockers}`}</li>
      <li>出槽：${removable ? `✅ 可出槽：${removable}` : '暂无器物达到出槽条件。'}</li>
    </ul>
    <div class="actions">
      <button data-action="liquid" data-tank="${tank.id}" ${tank.allSoakingEligible ? '' : 'disabled title="全部在泡器物共同达标后才可换液"'}>执行换液</button>
    </div>
  </div>`;
}

function roundFormHtml(tank) {
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  // 预填严格递增且晚于历史读数的采样时间（分钟精度，逐件 +1 分钟）。
  const baseMinute = Math.ceil(Math.max(Date.now(), (tank.lastTs ?? 0) + 1) / 60000) * 60000;
  const rows = soaking.map((a, i) => `
    <div class="reading-row" data-artifact="${a.id}">
      <span class="reading-name">${esc(a.name)}</span>
      <label>电导率（整数 µS/cm）
        <input type="number" min="0" step="1" required data-field="value" placeholder="如：980">
      </label>
      <label>采样时间
        <input type="datetime-local" required data-field="ts" value="${toLocalInputValue(baseMinute + i * 60000)}">
      </label>
    </div>`).join('');
  return `<form class="round-form" data-tank="${tank.id}" novalidate>
    <h4>提交本周期第 ${tank.nextRoundInPeriod} 轮读数</h4>
    ${rows}
    <div class="errors" hidden></div>
    <div class="actions"><button type="submit" class="primary">提交第 ${tank.nextRoundInPeriod} 轮读数</button></div>
  </form>`;
}

/**
 * 漂移复核面板：换液或出槽前，填写本周期每轮共用的最大整数校正幅度
 * 与相邻轮允许的最大校正变化，复核资格结论在电导仪缓慢漂移下是否仍可靠。
 * 复核结果只绑定产生时的修订号，不落盘；任何写入、换液、出槽、
 * 其他标签页更新或刷新重放都会重渲染本页，使旧结论自动失效。
 */
function driftReviewHtml(tank) {
  return `<div class="drift-review" data-tank="${tank.id}">
    <h4>漂移复核（电导仪缓慢漂移）</h4>
    <p class="muted">系统将从所见修订号重放本槽自上次换液后的全部在泡器物读数，为每轮联合选择一个共享整数校正值（而非分别调整单件读数），精确判定所有允许校正轨迹下资格是否仍成立。</p>
    <div class="drift-inputs">
      <label>最大整数校正幅度（µS/cm）
        <input type="number" min="0" step="1" data-drift="max" placeholder="如：5">
      </label>
      <label>相邻轮最大校正变化（µS/cm）
        <input type="number" min="0" step="1" data-drift="delta" placeholder="如：2">
      </label>
      <button type="button" data-action="review-drift" data-tank="${tank.id}">复核漂移影响</button>
    </div>
    <div class="errors" hidden></div>
    <div class="drift-result" hidden></div>
  </div>`;
}

/** 复核结论：绑定产生时的修订号展示。 */
function driftResultHtml(result, revision, currentlyEligible) {
  const bound = `<p class="muted">结论绑定修订号 r${revision}（第 ${result.period + 1} 周期共 ${result.rounds} 轮读数，自首项记录重放）；任何写入、换液、出槽、其他标签页更新或刷新后自动失效，需重新复核。</p>`;
  if (result.note === 'no-soaking') {
    return `<div class="drift-verdict pending">该槽器物均已出槽，无需复核。</div>${bound}`;
  }
  if (result.note === 'no-readings') {
    return `<div class="drift-verdict pending">本周期尚无读数，无法复核。</div>${bound}`;
  }
  if (result.note === 'insufficient-rounds') {
    return `<div class="drift-verdict pending">本周期仅 ${result.rounds} 轮，不足所需连续 ${result.requiredRounds} 轮，资格尚不成立，漂移复核暂不提供结论。</div>${bound}`;
  }
  const { maxCorrection, maxDelta } = result.params;
  if (result.robust) {
    return `<div class="drift-verdict ok">✅ 该槽资格经得住漂移：在每轮共享整数校正 |c|≤${maxCorrection}、相邻轮变化 ≤${maxDelta} 的全部允许轨迹下，全部在泡器物仍满足连续 ${result.requiredRounds} 轮严格下降且末值 ≤${result.limit}。</div>${bound}`;
  }
  const w = result.witness;
  const seq = w.corrections.map((c, i) => `第 ${i + 1} 轮 ${c >= 0 ? '+' : ''}${c}`).join('，');
  const verdict = currentlyEligible
    ? '⚠️ 该槽资格仅在原始读数下暂时成立'
    : '❌ 该槽资格当前尚不成立，且在允许漂移下最早于以下轮次被推翻';
  return `<div class="drift-verdict warn">${verdict}：存在允许校正轨迹使「${esc(w.artifactName)}」最早在本周期第 ${w.round} 轮失去资格。</div>
    <dl class="drift-witness">
      <dt>最早受影响器物</dt><dd>「${esc(w.artifactName)}」（本周期第 ${w.round} 轮）</dd>
      <dt>失败原因</dt><dd>${esc(w.reason)}</dd>
      <dt>校正序列（每轮共享一个整数）</dt><dd>${seq}</dd>
      <dt>校正后该器物本周期读数</dt><dd>${w.adjustedValues.join(' → ')}</dd>
    </dl>${bound}`;
}

function renderEvent(ev, state) {
  const time = fmtTs(Date.parse(ev.at));
  switch (ev.type) {
    case EVENT_TYPES.SCHEME_CREATED: {
      const tanks = ev.tanks.map((t) => `槽「${esc(t.name)}」（上限 ${t.limit} µS/cm，需连续 ${t.requiredRounds} 轮，${t.artifacts.length} 件器物：${t.artifacts.map((a) => esc(a.name)).join('、')}）`).join('；');
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 建立方案「${esc(ev.name)}」：${tanks}`;
    }
    case EVENT_TYPES.ROUND_SUBMITTED: {
      const tank = state.tanks.find((t) => t.id === ev.tankId);
      const nameOf = (id) => {
        const found = tank && tank.artifacts.find((a) => a.id === id);
        return found ? found.name : id;
      };
      const readings = ev.readings
        .map((r) => `${esc(nameOf(r.artifactId))}=${r.value} µS/cm @ ${fmtTs(r.ts)}`)
        .join('，');
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 槽「${esc(tank ? tank.name : ev.tankId)}」第 ${ev.period + 1} 周期第 ${ev.roundInPeriod} 轮读数：${readings}`;
    }
    case EVENT_TYPES.LIQUID_CHANGED: {
      const tank = state.tanks.find((t) => t.id === ev.tankId);
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 槽「${esc(tank ? tank.name : ev.tankId)}」执行换液，该槽轮次清零`;
    }
    case EVENT_TYPES.ARTIFACT_REMOVED: {
      const tank = state.tanks.find((t) => t.id === ev.tankId);
      const artifact = tank && tank.artifacts.find((a) => a.id === ev.artifactId);
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 器物「${esc(artifact ? artifact.name : ev.artifactId)}」完成出槽，不再接受读数`;
    }
    default:
      return `<strong>#${ev.seq}</strong> <span class="muted">${time}</span> 未知事件`;
  }
}

function bindDetail(ctx, record, tanks) {
  const { root } = ctx;
  const tankById = new Map(tanks.map((t) => [t.id, t]));

  root.querySelectorAll('form.round-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const tank = tankById.get(form.dataset.tank);
      const errBox = form.querySelector('.errors');
      const readings = [...form.querySelectorAll('.reading-row')].map((row) => {
        const valueRaw = row.querySelector('[data-field="value"]').value;
        const tsRaw = row.querySelector('[data-field="ts"]').value;
        return {
          artifactId: row.dataset.artifact,
          value: valueRaw === '' ? NaN : Number(valueRaw),
          ts: tsRaw ? new Date(tsRaw).getTime() : NaN,
        };
      });
      const errors = validateRound(tank, readings);
      if (errors.length > 0) {
        errBox.hidden = false;
        errBox.innerHTML = errors.map(esc).join('<br>');
        return;
      }
      errBox.hidden = true;
      await mutate(ctx, record, () => buildRoundEvent(tank, readings), '读数已提交');
    });
  });

  root.querySelectorAll('button[data-action="liquid"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tank = tankById.get(btn.dataset.tank);
      await mutate(ctx, record, () => buildLiquidChangeEvent(tank), '已执行换液，本槽轮次清零');
    });
  });

  root.querySelectorAll('button[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tank = tankById.get(btn.dataset.tank);
      await mutate(ctx, record, () => buildRemovalEvent(tank, btn.dataset.artifact), '器物已出槽');
    });
  });

  root.querySelectorAll('button[data-action="review-drift"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('.drift-review');
      const errBox = panel.querySelector('.errors');
      const resultBox = panel.querySelector('.drift-result');
      const val = (key) => panel.querySelector(`[data-drift="${key}"]`).value;
      const params = {
        maxCorrection: val('max') === '' ? NaN : Number(val('max')),
        maxDelta: val('delta') === '' ? NaN : Number(val('delta')),
      };
      const errors = validateDriftParams(params);
      if (errors.length > 0) {
        errBox.hidden = false;
        errBox.innerHTML = errors.map(esc).join('<br>');
        resultBox.hidden = true;
        return;
      }
      errBox.hidden = true;
      // 复核必须基于所见修订号：若记录已在其他标签页或窗口更新，
      // 放弃本次复核并展示最新状态，避免旧结论冒充当前结论。
      const fresh = ctx.store.load(record.id);
      if (!fresh || fresh.revision !== record.revision) {
        renderDetail(ctx, record.id, {
          banner: `该方案已在其他标签页或窗口更新（最新修订号 r${fresh ? fresh.revision : '?'}），请基于最新状态重新复核。`,
        });
        return;
      }
      const tank = tankById.get(btn.dataset.tank);
      const result = reviewDrift(tank, params);
      resultBox.hidden = false;
      resultBox.innerHTML = driftResultHtml(result, record.revision, tank.allSoakingEligible);
    });
  });
}

/** 以所见修订号提交事件；陈旧操作不得写入，并展示最新状态。 */
async function mutate(ctx, record, buildEvent, successMessage) {
  let event;
  try {
    event = buildEvent();
  } catch (err) {
    if (err instanceof DomainError) {
      renderDetail(ctx, record.id, { banner: err.errors.join('；') });
      return;
    }
    throw err;
  }
  try {
    await ctx.store.append(record.id, event, record.revision);
    renderDetail(ctx, record.id);
    ctx.toast(`${successMessage}（修订号 r${record.revision + 1}）`);
  } catch (err) {
    if (err instanceof ConflictError) {
      renderDetail(ctx, record.id, {
        banner: `该方案已在其他标签页或窗口更新（最新修订号 r${err.current.revision}），本次操作未写入，已为您显示最新状态。`,
      });
      return;
    }
    throw err;
  }
}
