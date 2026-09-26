import { replayScheme, deriveTank } from '../domain/replay.js';
import {
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
  DomainError,
  EVENT_TYPES,
} from '../domain/events.js';
import { validateRound } from '../domain/validate.js';
import { reviewTankDrift, validateDriftParams, DRIFT_STATUS } from '../domain/drift.js';
import { ConflictError } from '../store/recordStore.js';
import { esc, fmtTs, toLocalInputValue } from './dom.js';

/**
 * 漂移复核结论只活在内存里，且绑定产生时的方案修订号与槽位。
 * 其他标签页写入、换液、出槽导致修订号前进，或刷新页面（模块重载）后，
 * 旧结论的修订号不再匹配当前渲染，绝不会继续冒充当前结论。
 * 键：schemeId::tankId；值携带产生时的 revision。
 */
const driftResults = new Map();
const driftResultKey = (schemeId, tankId) => `${schemeId}::${tankId}`;

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

  // 修订号前进（本页/其他标签页写入、换液、出槽）后，绑定旧修订号的复核结论立即作废。
  for (const tank of tanks) {
    const held = driftResults.get(driftResultKey(schemeId, tank.id));
    if (held && held.revision !== record.revision) {
      driftResults.delete(driftResultKey(schemeId, tank.id));
    }
  }

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
    ${tanks.map((tank) => tankCardHtml(tank, record, schemeId)).join('')}
    <section class="panel">
      <h3>过程记录（自首项记录重放 · 不可改写）</h3>
      <ol class="log">${record.events.map((ev) => `<li>${renderEvent(ev, state)}</li>`).join('')}</ol>
    </section>`;

  bindDetail(ctx, record, tanks);
}

function tankCardHtml(tank, record, schemeId) {
  const held = driftResults.get(driftResultKey(schemeId, tank.id));
  // 仅展示绑定当前修订号的结论；修订号不符的结论已在渲染前清除。
  const review = held && held.revision === record.revision ? held : null;
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
      : `${nextStepHtml(tank)}${roundFormHtml(tank)}`}
    ${driftReviewHtml(tank, review)}
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

/** 漂移复核面板：填写每轮最大校正幅度 M 与相邻轮最大变化 S，结论只读且绑定修订号。 */
function driftReviewHtml(tank, review) {
  const mVal = review ? review.params.maxCorrection : '';
  const sVal = review ? review.params.maxStep : '';
  return `
  <div class="drift-review" data-tank="${tank.id}">
    <h4>电导仪缓慢漂移复核（只读，不改写记录）</h4>
    <p class="muted">为每轮选择一个本槽全部在泡器物共用的整数校正值 c：|c| ≤ M，且相邻轮 |Δc| ≤ S。
    系统重放本槽自上次换液后的全部在泡器物读数，精确判定所有允许校正轨迹下资格是否仍成立。</p>
    <form class="drift-form" novalidate>
      <label>每轮最大整数校正幅度 M（µS/cm）
        <input type="number" min="0" step="1" required data-field="max-correction" value="${mVal}" placeholder="如：10">
      </label>
      <label>相邻轮最大校正变化 S（µS/cm）
        <input type="number" min="0" step="1" required data-field="max-step" value="${sVal}" placeholder="如：3">
      </label>
      <div class="actions"><button type="submit" class="primary">复核资格是否经得住漂移</button></div>
      <div class="errors" hidden></div>
    </form>
    ${review ? driftVerdictHtml(tank, review) : ''}
  </div>`;
}

function signedInt(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function driftVerdictHtml(tank, review) {
  const bound = `<p class="muted drift-bound">本结论基于修订号 <strong>r${review.revision}</strong> 的重放；其他标签页写入、换液、出槽或刷新重放后须重新复核。</p>`;
  if (review.status !== DRIFT_STATUS.OK) {
    const message = {
      [DRIFT_STATUS.EMPTY]: '本槽器物均已出槽，无需复核。',
      [DRIFT_STATUS.NO_ROUNDS]: '本周期尚无读数，暂无可复核的漂移轨迹。',
      [DRIFT_STATUS.INSUFFICIENT_ROUNDS]: `本周期仅完成 ${review.rounds} 轮，不足所需连续 ${review.requiredRounds} 轮，原始读数下资格尚不成立，漂移复核无意义。`,
    }[review.status];
    return `<div class="drift-verdict pending">${bound}<p>${esc(message)}</p></div>`;
  }
  if (review.robust) {
    return `<div class="drift-verdict robust">
      ${bound}
      <p class="drift-headline">✅ 资格经得住漂移：在 M=${review.params.maxCorrection}、S=${review.params.maxStep} 的全部允许校正轨迹下，
      每件在泡器物末尾 ${review.requiredRounds} 轮仍逐轮严格下降，且末值不高于上限 ${review.limit}。</p>
      ${driftArtifactTable(tank, review)}
    </div>`;
  }
  const w = review.witness;
  if (!review.rawEligible) {
    if (!w) {
      return `<div class="drift-verdict pending">${bound}<p>原始读数下该槽资格本就暂不成立，漂移复核无法恢复资格；请先继续提交读数。</p></div>`;
    }
    return `<div class="drift-verdict pending">
      ${bound}
      <p class="drift-headline">原始读数下该槽资格本就暂不成立，漂移复核无法恢复资格；最早的问题：</p>
      <ul class="drift-witness">
        <li><strong>器物：</strong>${esc(w.artifactName)}（第 ${w.round} 轮）</li>
        <li><strong>问题：</strong>${esc(w.reason)}</li>
        <li><strong>校正序列 c₁…cₙ：</strong><span class="trend">${esc(w.correction.map(signedInt).join('，'))}</span></li>
        <li><strong>该器物校正后读数：</strong><span class="trend">${esc(w.correctedValues.join(' → '))}</span></li>
      </ul>
      ${driftArtifactTable(tank, review)}
    </div>`;
  }
  const correctionSeq = w.correction.map(signedInt).join('，');
  const correctedSeq = w.correctedValues.join(' → ');
  return `<div class="drift-verdict fragile">
    ${bound}
    <p class="drift-headline">⚠️ 仅在原始读数下暂时成立：存在允许的校正轨迹推翻当前资格。</p>
    <ul class="drift-witness">
      <li><strong>最早受影响器物：</strong>${esc(w.artifactName)}（第 ${w.round} 轮）</li>
      <li><strong>失败原因：</strong>${esc(w.reason)}</li>
      <li><strong>校正序列 c₁…cₙ：</strong><span class="trend">${esc(correctionSeq)}</span></li>
      <li><strong>该器物校正后读数：</strong><span class="trend">${esc(correctedSeq)}</span></li>
      <li class="muted">${esc(w.detail)}</li>
    </ul>
    ${driftArtifactTable(tank, review)}
  </div>`;
}

function driftArtifactTable(tank, review) {
  return `<table class="grid drift-grid">
    <thead><tr><th>器物</th><th>末值余量（上限 − 末值）</th><th>末尾窗口最小落差</th><th>漂移下结论</th></tr></thead>
    <tbody>${review.artifacts.map((a) => `<tr>
      <td>${esc(a.name)}</td>
      <td class="trend">${a.lastMargin}</td>
      <td class="trend">${a.minGap == null ? '—' : a.minGap}</td>
      <td>${a.robust ? '<span class="badge ok">所有轨迹仍达标</span>' : '<span class="badge pending">存在轨迹被推翻</span>'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
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

  root.querySelectorAll('form.drift-form').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const tankId = form.closest('.drift-review').dataset.tank;
      const tank = tankById.get(tankId);
      const errBox = form.querySelector('.errors');
      const num = (field) => {
        const raw = form.querySelector(`[data-field="${field}"]`).value;
        return raw === '' ? NaN : Number(raw);
      };
      const params = { maxCorrection: num('max-correction'), maxStep: num('max-step') };
      const errors = validateDriftParams(params);
      if (errors.length > 0) {
        errBox.hidden = false;
        errBox.innerHTML = errors.map(esc).join('<br>');
        return;
      }
      errBox.hidden = true;
      // 只读分析：不写入任何事件，结论绑定产生时所见的修订号。
      const result = reviewTankDrift(tank, params);
      driftResults.set(driftResultKey(record.id, tankId), { revision: record.revision, ...result });
      renderDetail(ctx, record.id);
      ctx.toast(result.robust ? '漂移复核：该槽资格经得住漂移' : '漂移复核：存在推翻资格的校正轨迹');
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
